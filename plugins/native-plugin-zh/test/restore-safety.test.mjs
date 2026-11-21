import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-restore-safety-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(codexHome, "plugin-i18n-native");
const pluginRoot = path.join(root, "target-plugin");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
process.env.CODEX_HOME = codexHome;
process.env.CODEX_PLUGIN_ZH_DATA_DIR = dataDir;
process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP = "1";
process.env.USERPROFILE = root;
process.env.HOME = root;

const { purgeDataAfterRestore } = await import("../lib/maintenance.mjs");
const { restoreOriginals } = await import("../lib/sync.mjs");
const { loadState, saveState } = await import("../lib/storage.mjs");
const { sha256 } = await import("../lib/paths.mjs");

const key = "openai-bundled/browser";
const english = "Control the in-app browser";
const chinese = "控制应用内浏览器";
const englishLong = "Browse the web from the side panel";
const chineseLong = "从侧边面板浏览网页";

fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      name: "browser",
      interface: {
        shortDescription: "User edited this field",
        longDescription: chineseLong,
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

saveState({
  schemaVersion: 2,
  locale: "zh-CN",
  enabled: true,
  overlayActive: true,
  lastPluginConfigEnabled: true,
  plugins: {
    [key]: {
      key,
      marketplace: "openai-bundled",
      pluginName: "browser",
      sourcePath: pluginRoot,
      manifestPath,
      interfaceExisted: true,
      fields: {
        displayName: {
          source: "Browser",
          sourceHash: sha256("Browser"),
          translation: "浏览器",
          originalPresent: true,
          originalValue: "Browser",
        },
        shortDescription: {
          source: english,
          sourceHash: sha256(english),
          translation: chinese,
          originalPresent: true,
          originalValue: english,
        },
        longDescription: {
          source: englishLong,
          sourceHash: sha256(englishLong),
          translation: chineseLong,
          originalPresent: true,
          originalValue: englishLong,
        },
      },
    },
  },
});

test("restore preserves user edits and deleted fields, and purge refuses incomplete recovery", async () => {
  const restored = await restoreOriginals({
    preserveIntent: true,
    lastPluginConfigEnabled: false,
    reason: "safety-test",
    trigger: "test",
    quiet: true,
  });

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.interface.displayName, undefined);
  assert.equal(manifest.interface.shortDescription, "User edited this field");
  assert.equal(manifest.interface.longDescription, englishLong);
  assert.equal(restored.conflicts.length, 2);
  assert.equal(restored.restoredFields, 1);

  const blocked = purgeDataAfterRestore(restored, { purge: true });
  assert.equal(blocked.purged, false);
  assert.equal(blocked.reason, "restore-conflicts");
  assert.equal(fs.existsSync(path.join(dataDir, "state.json")), true);

  const skippedPurge = purgeDataAfterRestore(
    { skipped: true, conflicts: [], errors: [] },
    { purge: true },
  );
  assert.equal(skippedPurge.purged, false);
  assert.equal(skippedPurge.reason, "restore-skipped");
  assert.equal(loadState().overlayActive, false);
});

test("purge only removes recovery data after a complete restore", () => {
  const purged = purgeDataAfterRestore(
    { restoredPlugins: 1, restoredFields: 1, conflicts: [], errors: [] },
    { purge: true },
  );
  assert.equal(purged.purged, true);
  assert.equal(fs.existsSync(dataDir), false);
  fs.rmSync(root, { recursive: true, force: true });
});
