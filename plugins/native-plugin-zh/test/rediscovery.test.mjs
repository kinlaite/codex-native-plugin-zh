import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-rediscovery-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(codexHome, "plugin-i18n-native");
const marketplaceRoot = path.join(root, "marketplace");
const oldRoot = path.join(root, "old-browser");
const newRoot = path.join(marketplaceRoot, "plugins", "browser");
const oldManifest = path.join(oldRoot, ".codex-plugin", "plugin.json");
const newManifest = path.join(newRoot, ".codex-plugin", "plugin.json");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(oldManifest), { recursive: true });
fs.mkdirSync(path.dirname(newManifest), { recursive: true });
process.env.CODEX_HOME = codexHome;
process.env.CODEX_PLUGIN_ZH_DATA_DIR = dataDir;
process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP = "1";
process.env.USERPROFILE = root;
process.env.HOME = root;

const { runHookEvent } = await import("../lib/hooks.mjs");
const { loadState, saveState } = await import("../lib/storage.mjs");
const { sha256 } = await import("../lib/paths.mjs");

const english = "Control the in-app browser";
const chinese = "控制应用内浏览器";

function writeManifest(file, value) {
  fs.writeFileSync(
    file,
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

writeConfig(true);
writeManifest(oldManifest, chinese);
writeManifest(newManifest, english);
saveState({
  schemaVersion: 2,
  locale: "zh-CN",
  enabled: true,
  overlayActive: true,
  lastPluginConfigEnabled: true,
  lastSyncAt: null,
  plugins: {
    "openai-bundled/browser": {
      key: "openai-bundled/browser",
      marketplace: "openai-bundled",
      pluginName: "browser",
      sourcePath: oldRoot,
      manifestPath: oldManifest,
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
          source: "Browse the web",
          sourceHash: sha256("Browse the web"),
          translation: "浏览网页",
          originalPresent: true,
          originalValue: "Browse the web",
        },
      },
    },
  },
});

function readManifest(file) {
  return JSON.parse(fs.readFileSync(file, "utf8")).interface;
}

test("SessionStart rediscovers a moved local plugin before applying cached Chinese", async () => {
  const result = await runHookEvent("SessionStart", {
    session_id: "rediscovery",
    reason: "startup",
  });
  assert.equal(result.appliedFields, 3);
  assert.equal(readManifest(newManifest).shortDescription, chinese);
  const state = loadState();
  assert.equal(state.plugins["openai-bundled/browser"].manifestPath, newManifest);
});

test("SessionEnd restores the rediscovered plugin", async () => {
  writeConfig(false);
  await runHookEvent("SessionEnd", {
    session_id: "rediscovery",
    reason: "shutdown",
  });
  assert.equal(readManifest(newManifest).shortDescription, english);
  assert.equal(loadState().overlayActive, false);
});

test("cleans up the rediscovery fixture", () => {
  fs.rmSync(root, { recursive: true, force: true });
});
