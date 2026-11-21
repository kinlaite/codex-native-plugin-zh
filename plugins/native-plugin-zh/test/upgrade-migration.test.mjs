import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-upgrade-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(codexHome, "plugin-i18n-native");
const marketplaceRoot = path.join(root, "marketplace");
const pluginRoot = path.join(marketplaceRoot, "plugins", "browser");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
process.env.CODEX_HOME = codexHome;
process.env.CODEX_PLUGIN_ZH_DATA_DIR = dataDir;
process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP = "1";
process.env.USERPROFILE = root;
process.env.HOME = root;

const { cleanupLegacyResidue } = await import("../lib/migration.mjs");
const { runHookEvent } = await import("../lib/hooks.mjs");
const { loadState, saveState } = await import("../lib/storage.mjs");
const { sha256 } = await import("../lib/paths.mjs");

const key = "openai-bundled/browser";
const english = "Control the in-app browser";
const chinese = "控制应用内浏览器";

function writeConfig(enabled) {
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    [
      '[plugins."native-plugin-zh@native-plugin-zh-local"]',
      `enabled = ${enabled}`,
      "",
      "[marketplaces.openai-bundled]",
      'source_type = "local"',
      `source = '${marketplaceRoot.replaceAll("\\", "/")}'`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function writeManifest() {
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        name: "browser",
        interface: {
          displayName: "Browser",
          shortDescription: english,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writePack() {
  fs.writeFileSync(
    path.join(dataDir, "translations.zh-CN.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        locale: "zh-CN",
        plugins: {
          [key]: {
            displayName: { sourceHash: sha256("Browser"), text: "浏览器" },
            shortDescription: { sourceHash: sha256(english), text: chinese },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

test("an old manual pause without a lifecycle marker stays paused after upgrade", async () => {
  writeConfig(true);
  writeManifest();
  writePack();
  saveState({
    schemaVersion: 1,
    locale: "zh-CN",
    enabled: false,
    lastSyncAt: null,
    plugins: {},
  });

  const result = await runHookEvent("SessionStart", { session_id: "old-pause" });
  assert.equal(result.reason, "intent-disabled");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.interface.shortDescription, english);
  const state = loadState();
  assert.equal(state.enabled, false);
  assert.equal(state.lastPluginConfigEnabled, true);
});

test("an old active state without a marker migrates to an enabled lifecycle", async () => {
  writeConfig(true);
  writeManifest();
  saveState({
    schemaVersion: 1,
    locale: "zh-CN",
    enabled: true,
    lastSyncAt: null,
    plugins: {},
  });

  await runHookEvent("SessionStart", { session_id: "old-active" });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.interface.shortDescription, chinese);
  const state = loadState();
  assert.equal(state.enabled, true);
  assert.equal(state.lastPluginConfigEnabled, true);
});

test("legacy task removal failure retains all residue so a later run can retry", () => {
  const toolDir = path.join(dataDir, "tool");
  const taskXml = path.join(dataDir, "task.xml");
  fs.mkdirSync(toolDir, { recursive: true });
  fs.writeFileSync(path.join(toolDir, "cli.mjs"), "// legacy\n", "utf8");
  fs.writeFileSync(taskXml, "<Task />\n", "utf8");
  fs.writeFileSync(
    path.join(dataDir, "settings.json"),
    `${JSON.stringify({ taskName: "CodexPluginZhNativeSync", schemaVersion: 1 })}\n`,
    "utf8",
  );

  const failed = cleanupLegacyResidue({
    removeTaskImpl: () => ({
      found: true,
      removed: false,
      error: "Access denied",
    }),
  });
  assert.equal(failed.retryable, true);
  assert.equal(fs.existsSync(toolDir), true);
  assert.equal(fs.existsSync(taskXml), true);
  const settings = JSON.parse(
    fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"),
  );
  assert.equal(settings.taskName, "CodexPluginZhNativeSync");

  const retried = cleanupLegacyResidue({
    removeTaskImpl: () => ({ found: true, removed: true, error: null }),
  });
  assert.equal(retried.retryable, false);
  assert.equal(fs.existsSync(toolDir), false);
  assert.equal(fs.existsSync(taskXml), false);
  const cleaned = JSON.parse(
    fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"),
  );
  assert.equal(cleaned.taskName, undefined);
});

test("cleans up the upgrade fixture", () => {
  fs.rmSync(root, { recursive: true, force: true });
});
