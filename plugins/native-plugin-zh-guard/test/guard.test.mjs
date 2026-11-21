import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-guard-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(codexHome, "plugin-i18n-native");
const pluginRoot = path.join(root, "target-plugin");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const backupDir = path.join(dataDir, "backups");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
process.env.CODEX_HOME = codexHome;
process.env.CODEX_PLUGIN_ZH_DATA_DIR = dataDir;
process.env.USERPROFILE = root;
process.env.HOME = root;

const { historyTail } = await import("../lib/lifecycle.mjs");
const { runGuardSessionStart } = await import("../lib/guard.mjs");
const { loadState } = await import("../lib/storage.mjs");
const { sha256 } = await import("../lib/paths.mjs");

const english = "Control the in-app browser";
const chinese = "控制应用内浏览器";
const key = "openai-bundled/browser";

function writeConfig(enabled, marketplace = "native-plugin-zh-local") {
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    `[plugins."native-plugin-zh@${marketplace}"]\nenabled = ${enabled}\n`,
    "utf8",
  );
}

function writeManifest(value = english) {
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        name: "browser",
        interface: {
          displayName: value === english ? "Browser" : "浏览器",
          shortDescription: value,
          longDescription: value === english ? "Browse the web" : "浏览网页",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function field(source, translation, originalValue = source) {
  return {
    source,
    sourceHash: sha256(source),
    translation,
    originalPresent: true,
    originalValue,
  };
}

function writeState({ overlayActive = true, lastPluginConfigEnabled = true } = {}) {
  const state = {
    schemaVersion: 2,
    locale: "zh-CN",
    enabled: true,
    overlayActive,
    lastPluginConfigEnabled,
    plugins: {
      [key]: {
        key,
        marketplace: "openai-bundled",
        pluginName: "browser",
        sourcePath: pluginRoot,
        manifestPath,
        interfaceExisted: true,
        fields: {
          displayName: field("Browser", "浏览器"),
          shortDescription: field(english, chinese),
          longDescription: field("Browse the web", "浏览网页"),
        },
      },
    },
  };
  fs.writeFileSync(
    path.join(dataDir, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  return state;
}

function writePack() {
  const plugins = {
    [key]: {
      displayName: { sourceHash: sha256("Browser"), text: "浏览器" },
      shortDescription: { sourceHash: sha256(english), text: chinese },
      longDescription: { sourceHash: sha256("Browse the web"), text: "浏览网页" },
    },
  };
  fs.writeFileSync(
    path.join(dataDir, "translations.zh-CN.json"),
    `${JSON.stringify({ schemaVersion: 1, locale: "zh-CN", plugins }, null, 2)}\n`,
    "utf8",
  );
}

function writeCleanBackup() {
  const entry = {
    key,
    marketplace: "openai-bundled",
    pluginName: "browser",
    sourcePath: pluginRoot,
    manifestPath,
    fields: {
      displayName: field("Browser", "浏览器"),
      shortDescription: field(english, chinese),
      longDescription: field("Browse the web", "浏览网页"),
    },
  };
  const record = {
    schemaVersion: 2,
    key,
    marketplace: "openai-bundled",
    pluginName: "browser",
    manifestPath,
    sourcePath: pluginRoot,
    savedAt: new Date().toISOString(),
    reason: "test",
    interfaceExisted: true,
    sourceFields: {
      displayName: "Browser",
      shortDescription: english,
      longDescription: "Browse the web",
    },
    originalFields: {
      displayName: { present: true, value: "Browser" },
      shortDescription: { present: true, value: english },
      longDescription: { present: true, value: "Browse the web" },
    },
    originalText: JSON.stringify({
      name: "browser",
      interface: {
        displayName: "Browser",
        shortDescription: english,
        longDescription: "Browse the web",
      },
    }),
  };
  fs.writeFileSync(
    path.join(backupDir, `${key.replace(/[^a-zA-Z0-9._-]+/g, "__")}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  return entry;
}

test("guard restores English when the main plugin is disabled", async () => {
  writeConfig(false);
  writeState();
  writeManifest(chinese);

  const result = await runGuardSessionStart();
  assert.equal(result.restoredFields, 3);
  assert.equal(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")).interface.shortDescription,
    english,
  );
  const state = loadState();
  assert.equal(state.enabled, true, "guard must preserve localization intent");
  assert.equal(state.overlayActive, false);
  assert.equal(state.lastPluginConfigEnabled, false);
  assert.equal(historyTail(3).at(-1).action, "guard");
});

test("guard is a no-op while the main plugin is enabled", async () => {
  writeConfig(true);
  writeState();
  writeManifest(chinese);

  const before = historyTail(50).length;
  const result = await runGuardSessionStart();
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "main-enabled");
  assert.equal(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")).interface.shortDescription,
    chinese,
  );
  assert.equal(historyTail(50).length, before);
});

test("guard honors the main plugin switch under a renamed marketplace", async () => {
  writeConfig(true, "renamed-marketplace");
  writeState();
  writeManifest(chinese);

  const result = await runGuardSessionStart();
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "main-enabled");
  assert.equal(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")).interface.shortDescription,
    chinese,
  );

  writeConfig(false, "renamed-marketplace");
  const restored = await runGuardSessionStart();
  assert.equal(restored.restoredFields, 3);
  assert.equal(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")).interface.shortDescription,
    english,
  );
});

test("guard does not write history on repeated no-op starts", async () => {
  writeConfig(false);
  writeState({ overlayActive: false, lastPluginConfigEnabled: false });
  writeManifest(english);

  const before = historyTail(50).length;
  await runGuardSessionStart();
  await runGuardSessionStart();
  assert.equal(historyTail(50).length, before);
});

test("guard recovers English from backups after state.json is lost", async () => {
  writeConfig(false);
  writeManifest(english);
  const entry = writeCleanBackup();
  writePack();
  writeManifest(chinese);
  fs.rmSync(path.join(dataDir, "state.json"), { force: true });

  const result = await runGuardSessionStart();
  assert.equal(result.recoveredBackupEntries, 1);
  assert.equal(result.restoredFields, 3);
  assert.equal(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")).interface.shortDescription,
    english,
  );
  assert.equal(entry.key, key);
  assert.equal(loadState().overlayActive, false);
});

test("cleans up guard fixture", () => {
  fs.rmSync(root, { recursive: true, force: true });
});
