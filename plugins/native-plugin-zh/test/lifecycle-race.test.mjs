import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-race-"));
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

const { runHookEvent } = await import("../lib/hooks.mjs");
const { loadState, saveState } = await import("../lib/storage.mjs");
const { sha256, withLock } = await import("../lib/paths.mjs");

const key = "openai-bundled/browser";
const english = "Control the in-app browser";
const chinese = "控制应用内浏览器";
const lockFile = path.join(dataDir, "sync.lock");

function writeConfig(enabled) {
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    `[plugins."native-plugin-zh@native-plugin-zh-local"]\nenabled = ${enabled}\n`,
    "utf8",
  );
}

function writeManifest(value) {
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        name: "browser",
        interface: {
          displayName: "Browser",
          shortDescription: value,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function waitForLock() {
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(lockFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(lockFile), true, "test lock should be held");
}

async function holdLock() {
  let release;
  const holder = withLock(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await waitForLock();
  return { holder, release };
}

test("SessionStart revalidates a disabled plugin after waiting for the lock", async () => {
  writeConfig(true);
  writeManifest(english);
  const { holder, release } = await holdLock();

  const hook = runHookEvent("SessionStart", { session_id: "toggle-off-during-wait" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeConfig(false);
  release();
  await holder;

  const result = await hook;
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "plugin-disabled-before-lock");
  assert.equal(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")).interface.shortDescription,
    english,
  );
  assert.equal(loadState().overlayActive, false);
});

test("SessionEnd revalidates a re-enabled plugin after waiting for the lock", async () => {
  writeConfig(false);
  writeManifest(chinese);
  saveState({
    schemaVersion: 2,
    locale: "zh-CN",
    enabled: true,
    overlayActive: true,
    lastPluginConfigEnabled: false,
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
        },
      },
    },
  });

  const { holder, release } = await holdLock();
  const hook = runHookEvent("SessionEnd", { session_id: "toggle-on-during-wait" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeConfig(true);
  release();
  await holder;

  const result = await hook;
  assert.equal(result.action, "keep");
  assert.equal(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")).interface.shortDescription,
    chinese,
  );
  assert.equal(loadState().overlayActive, true);
});

test("cleans up the lifecycle race fixture", () => {
  fs.rmSync(root, { recursive: true, force: true });
});
