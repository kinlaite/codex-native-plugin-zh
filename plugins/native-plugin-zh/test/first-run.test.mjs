import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-first-run-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(codexHome, "plugin-i18n-native");
const marketplaceRoot = path.join(
  codexHome,
  ".tmp",
  "bundled-marketplaces",
  "openai-bundled",
);
const browserRoot = path.join(marketplaceRoot, "plugins", "browser");
const manifestPath = path.join(browserRoot, ".codex-plugin", "plugin.json");

fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(codexHome, "config.toml"),
  '[plugins."native-plugin-zh@native-plugin-zh-local"]\nenabled = true\n',
  "utf8",
);
fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      name: "browser",
      interface: {
        displayName: "Browser",
        shortDescription: "Control the in-app browser",
        longDescription:
          "Browser lets ChatGPT open and control the in-app browser, mainly for local development pages and files. Use it to navigate, inspect, click, type, and take screenshots while testing pages inside ChatGPT.",
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.env.CODEX_HOME = codexHome;
process.env.CODEX_PLUGIN_ZH_DATA_DIR = dataDir;
process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP = "1";
process.env.USERPROFILE = root;
process.env.HOME = root;

const { runHookEvent } = await import("../lib/hooks.mjs");
const { loadState } = await import("../lib/storage.mjs");

function manifest() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

test("first enable discovers local plugins and applies bundled translations", async () => {
  const result = await runHookEvent("SessionStart", {
    session_id: "first-run",
    reason: "startup",
  });
  assert.equal(result.appliedFields, 3);
  assert.equal(manifest().interface.displayName, "浏览器");
  assert.equal(manifest().interface.shortDescription, "控制应用内浏览器");
  assert.equal(loadState().lastPluginConfigEnabled, true);
});

test("disabling the plugin restores the original English manifest", async () => {
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    '[plugins."native-plugin-zh@native-plugin-zh-local"]\nenabled = false\n',
    "utf8",
  );
  await runHookEvent("SessionEnd", {
    session_id: "first-run",
    reason: "shutdown",
  });
  assert.equal(manifest().interface.displayName, "Browser");
  assert.equal(manifest().interface.shortDescription, "Control the in-app browser");
  const state = loadState();
  assert.equal(state.enabled, true);
  assert.equal(state.lastPluginConfigEnabled, false);
});

test("cleans up the first-run fixture", () => {
  fs.rmSync(root, { recursive: true, force: true });
});
