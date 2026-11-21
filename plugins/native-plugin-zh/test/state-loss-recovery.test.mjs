import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-state-loss-"));
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

const { runHookEvent } = await import("../lib/hooks.mjs");
const { loadState } = await import("../lib/storage.mjs");
const { sha256 } = await import("../lib/paths.mjs");

const key = "openai-bundled/browser";
const english = "Control the in-app browser";
const chinese = "控制应用内浏览器";
const englishLong = "Browse the web from the side panel";
const chineseLong = "从侧边面板浏览网页";

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

function writeManifest(shortDescription = english, longDescription = englishLong) {
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        name: "browser",
        interface: {
          displayName: "Browser",
          shortDescription,
          longDescription,
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
            displayName: {
              sourceHash: sha256("Browser"),
              text: "浏览器",
            },
            shortDescription: {
              sourceHash: sha256(english),
              text: chinese,
            },
            longDescription: {
              sourceHash: sha256(englishLong),
              text: chineseLong,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

writeConfig(true);
writeManifest();
writePack();

test("SessionStart recovers clean originals from backups after state.json is lost", async () => {
  await runHookEvent("SessionStart", { session_id: "first-start" });
  let manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.interface.shortDescription, chinese);

  const backupFile = path.join(dataDir, "backups", "openai-bundled__browser.json");
  const firstBackup = JSON.parse(fs.readFileSync(backupFile, "utf8"));
  assert.equal(firstBackup.originalFields.shortDescription.present, true);
  assert.equal(
    JSON.parse(firstBackup.originalText).interface.shortDescription,
    english,
  );

  fs.rmSync(path.join(dataDir, "state.json"), { force: true });
  await runHookEvent("SessionStart", { session_id: "after-state-loss" });

  const state = loadState();
  assert.equal(
    state.plugins[key].fields.shortDescription.originalValue,
    english,
  );
  assert.equal(
    state.plugins[key].fields.longDescription.originalValue,
    englishLong,
  );
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.interface.shortDescription, chinese);

  writeConfig(false);
  const restored = await runHookEvent("SessionEnd", { session_id: "shutdown" });
  assert.equal(restored.restoredFields, 3);
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.interface.shortDescription, english);
  assert.equal(manifest.interface.longDescription, englishLong);
  assert.equal(loadState().overlayActive, false);
});

test("partial source changes never overwrite the clean backup with Chinese", async () => {
  writeConfig(true);
  writeManifest("New English source", chineseLong);
  await runHookEvent("SessionStart", { session_id: "partial-overlay" });

  const backup = JSON.parse(
    fs.readFileSync(
      path.join(dataDir, "backups", "openai-bundled__browser.json"),
      "utf8",
    ),
  );
  const original = JSON.parse(backup.originalText);
  assert.equal(original.interface.shortDescription, "New English source");
  assert.equal(original.interface.longDescription, englishLong);
  assert.equal(backup.originalFields.longDescription.value, englishLong);
});

test("cleans up the state-loss fixture", () => {
  fs.rmSync(root, { recursive: true, force: true });
});
