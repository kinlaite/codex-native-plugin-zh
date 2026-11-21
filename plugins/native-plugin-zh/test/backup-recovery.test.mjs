import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-backup-recovery-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(codexHome, "plugin-i18n-native");
const pluginRoot = path.join(root, "target-plugin");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.CODEX_HOME = codexHome;
process.env.CODEX_PLUGIN_ZH_DATA_DIR = dataDir;
process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP = "1";

const { restoreOriginals } = await import("../lib/sync.mjs");
const { loadState, readManifest, saveBackup, savePack } = await import("../lib/storage.mjs");
const { sha256 } = await import("../lib/paths.mjs");

const english = "Control the in-app browser";
const chinese = "控制应用内浏览器";
const key = "openai-bundled/browser";

function writeManifest(value) {
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        name: "browser",
        interface: {
          displayName: "Browser",
          shortDescription: value,
          longDescription: "Browse the web",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

writeManifest(english);
const original = readManifest(manifestPath);
saveBackup(
  {
    key,
    marketplace: "openai-bundled",
    pluginName: "browser",
    manifestPath,
    sourcePath: pluginRoot,
  },
  original,
  {
    displayName: "Browser",
    shortDescription: english,
    longDescription: "Browse the web",
  },
  "first-apply",
);
savePack({
  schemaVersion: 1,
  locale: "zh-CN",
  plugins: {
    [key]: {
      shortDescription: {
        sourceHash: sha256(english),
        text: chinese,
        origin: "test",
      },
    },
  },
});
writeManifest(chinese);
fs.writeFileSync(path.join(dataDir, "state.json"), "{broken json", "utf8");

test("restores Chinese overlay from backups when state.json is corrupt", async () => {
  const result = await restoreOriginals({
    preserveIntent: true,
    lastPluginConfigEnabled: false,
    reason: "recovery-test",
    trigger: "test",
    quiet: true,
  });
  assert.equal(result.recoveredBackupEntries, 1);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).interface.shortDescription, english);
  const state = loadState();
  assert.equal(state.overlayActive, false);
  assert.equal(state.plugins[key].manifestPath, manifestPath);
});

test("cleans up the backup recovery fixture", () => {
  fs.rmSync(root, { recursive: true, force: true });
});
