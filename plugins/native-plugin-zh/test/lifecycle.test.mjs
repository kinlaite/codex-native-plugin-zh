import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-lifecycle-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(codexHome, "plugin-i18n-native");
const pluginRoot = path.join(root, "target-plugin");
const pluginDir = path.join(pluginRoot, ".codex-plugin");
const manifestPath = path.join(pluginDir, "plugin.json");
fs.mkdirSync(pluginDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.CODEX_HOME = codexHome;
process.env.CODEX_PLUGIN_ZH_DATA_DIR = dataDir;
process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP = "1";
process.env.USERPROFILE = root;
process.env.HOME = root;

const { parsePluginConfigState, readPluginConfigState, historyTail } = await import(
  "../lib/lifecycle.mjs"
);
const { applyCached, restoreOriginals } = await import("../lib/sync.mjs");
const { runHookEvent } = await import("../lib/hooks.mjs");
const { loadState, saveState } = await import("../lib/storage.mjs");
const { sha256 } = await import("../lib/paths.mjs");

const english = "Control the in-app browser";
const chinese = "控制应用内浏览器";

function writeConfig(enabled, marketplace = "native-plugin-zh-local") {
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    `[plugins."native-plugin-zh@${marketplace}"]\nenabled = ${enabled}\n`,
    "utf8",
  );
}

function writeManifest(shortDescription = english) {
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        name: "browser",
        interface: {
          displayName: "Browser",
          shortDescription,
          longDescription: "Browse the web",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeState({
  enabled = true,
  overlayActive = false,
  lastPluginConfigEnabled,
} = {}) {
  writeManifest();
  const state = {
    schemaVersion: 2,
    locale: "zh-CN",
    enabled,
    overlayActive,
    lastSyncAt: null,
    plugins: {
      "openai-bundled/browser": {
        key: "openai-bundled/browser",
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
            source: "Browse the web",
            sourceHash: sha256("Browse the web"),
            translation: "浏览网页",
            originalPresent: true,
            originalValue: "Browse the web",
          },
        },
      },
    },
  };
  if (typeof lastPluginConfigEnabled === "boolean") {
    state.lastPluginConfigEnabled = lastPluginConfigEnabled;
  }
  saveState(state);
}

test("parses the plugin switch from config.toml", () => {
  writeConfig(false);
  assert.deepEqual(readPluginConfigState(), {
    pluginId: "native-plugin-zh@native-plugin-zh-local",
    found: true,
    enabled: false,
    enabledLine: "enabled = false",
    configFile: path.join(codexHome, "config.toml"),
  });
  assert.equal(
    parsePluginConfigState(
      '[plugins."other@local"]\nenabled = true\n\n[plugins."native-plugin-zh@native-plugin-zh-local"]\nenabled = true\n',
    ).enabled,
    true,
  );
  writeConfig(true, "renamed-marketplace");
  assert.equal(readPluginConfigState().enabled, true);
  assert.equal(readPluginConfigState().pluginId, "native-plugin-zh@renamed-marketplace");
});

test("applies cached Chinese and preserves user intent when the plugin is disabled", async () => {
  writeConfig(true);
  writeState({ enabled: true, overlayActive: false });

  const applied = await applyCached({
    reason: "test",
    trigger: "test",
    quiet: true,
  });
  assert.equal(applied.appliedFields, 3);
  let manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.interface.shortDescription, chinese);
  assert.equal(loadState().overlayActive, true);

  writeConfig(false);
  const restored = await restoreOriginals({
    preserveIntent: true,
    onlyIfOverlayActive: true,
    reason: "plugin-disabled",
    trigger: "SessionEnd",
    quiet: true,
  });
  assert.equal(restored.restoredFields, 3);
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.interface.shortDescription, english);
  const state = loadState();
  assert.equal(state.enabled, true, "plugin disable must not wipe the user's localization intent");
  assert.equal(state.overlayActive, false);
  assert.equal(historyTail(5).at(-1).reason, "plugin-disabled");
});

test("manual restore pauses localization and does not reapply without user action", async () => {
  writeConfig(true);
  writeState({ enabled: true, overlayActive: true });
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        name: "browser",
        interface: {
          displayName: "浏览器",
          shortDescription: chinese,
          longDescription: "浏览网页",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await restoreOriginals({
    preserveIntent: false,
    reason: "manual-tool",
    trigger: "test",
    quiet: true,
  });
  assert.equal(loadState().enabled, false);
  const reapplied = await applyCached({ reason: "test", trigger: "test", quiet: true });
  assert.equal(reapplied.disabled, true);
});

test("does not overwrite a target plugin whose English source changed", async () => {
  writeConfig(true);
  writeState({ enabled: true, overlayActive: false });
  writeManifest("New English source");
  const result = await applyCached({ reason: "test", trigger: "test", quiet: true });
  assert.equal(result.appliedFields, 2);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.interface.shortDescription, "New English source");
  assert.equal(manifest.interface.displayName, "浏览器");
});

test("SessionStart applies and SessionEnd restores across a plugin toggle", async () => {
  writeConfig(true);
  writeState({
    enabled: true,
    overlayActive: false,
    lastPluginConfigEnabled: false,
  });

  await runHookEvent("SessionStart", {
    session_id: "hook-session",
    reason: "startup",
  });
  let manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.interface.shortDescription, chinese);
  let state = loadState();
  assert.equal(state.enabled, true);
  assert.equal(state.lastPluginConfigEnabled, true);
  assert.equal(state.overlayActive, true);

  writeConfig(false);
  await runHookEvent("SessionEnd", {
    session_id: "hook-session",
    reason: "shutdown",
  });
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.interface.shortDescription, english);
  state = loadState();
  assert.equal(state.enabled, true);
  assert.equal(state.lastPluginConfigEnabled, false);
  assert.equal(state.overlayActive, false);

  writeConfig(true);
  await runHookEvent("SessionStart", {
    session_id: "hook-session-2",
    reason: "startup",
  });
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.interface.shortDescription, chinese);
  assert.equal(loadState().lastPluginConfigEnabled, true);
});

test("a manual pause stays paused when the plugin is still enabled", async () => {
  writeConfig(true);
  writeState({
    enabled: false,
    overlayActive: false,
    lastPluginConfigEnabled: true,
  });

  const result = await runHookEvent("SessionStart", {
    session_id: "manually-paused",
    reason: "startup",
  });
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "intent-disabled");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.interface.shortDescription, english);
});

test("cleans up temporary lifecycle fixture", () => {
  fs.rmSync(root, { recursive: true, force: true });
});
