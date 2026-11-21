import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-watcher-"));
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

const configPath = path.join(codexHome, "config.toml");
const { saveState } = await import("../lib/storage.mjs");
const { sha256 } = await import("../lib/paths.mjs");

const english = "Control the in-app browser";
const chinese = "控制应用内浏览器";
const englishLong = "Browse the web from the side panel";
const chineseLong = "从侧边面板浏览网页";

function writeConfig(enabled) {
  fs.writeFileSync(
    configPath,
    `[plugins."native-plugin-zh@native-plugin-zh-local"]\nenabled = ${enabled}\n`,
    "utf8",
  );
}

function writeManifest(mode) {
  const iface =
    mode === "chinese"
      ? { displayName: "浏览器", shortDescription: chinese, longDescription: chineseLong }
      : { displayName: "Browser", shortDescription: english, longDescription: englishLong };
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ name: "browser", interface: iface }, null, 2)}\n`,
    "utf8",
  );
}

function seedState() {
  saveState({
    schemaVersion: 2,
    locale: "zh-CN",
    enabled: true,
    overlayActive: true,
    lastPluginConfigEnabled: true,
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
}

function readManifestInterface() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")).interface;
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return false;
}

test("watcher restores English on disable and reapplies Chinese on enable", async () => {
  writeConfig(true);
  writeManifest("chinese");
  seedState();

  const { startConfigWatcher } = await import("../lib/watcher.mjs");
  const stop = startConfigWatcher({ pollMs: 60 });

  try {
    // 关闭插件 → 运行中的服务器应自动恢复英文
    writeConfig(false);
    const restored = await waitFor(() => {
      const iface = readManifestInterface();
      return iface.displayName === "Browser" && iface.shortDescription === english;
    });
    assert.equal(restored, true, "disable 应在监听周期内恢复英文");
    assert.equal(readManifestInterface().longDescription, englishLong);

    // 重新启用 → 应重新写入中文
    writeConfig(true);
    const reapplied = await waitFor(() => {
      const iface = readManifestInterface();
      return iface.shortDescription === chinese;
    });
    assert.equal(reapplied, true, "enable 应在监听周期内重新写入中文");
    assert.equal(readManifestInterface().displayName, "浏览器");
  } finally {
    stop();
  }
});

test("startup detects a switch change that happened while the watcher was down", async () => {
  writeConfig(true);
  writeManifest("english");
  seedState();
  fs.writeFileSync(
    path.join(dataDir, "last-switch.json"),
    `${JSON.stringify({
      signature: "native-plugin-zh@native-plugin-zh-local:found=false",
      found: true,
      enabled: false,
    })}\n`,
    "utf8",
  );

  const { startConfigWatcher } = await import("../lib/watcher.mjs");
  const stop = startConfigWatcher({ pollMs: 60 });
  try {
    const marker = JSON.parse(
      fs.readFileSync(path.join(dataDir, "last-switch.json"), "utf8"),
    );
    assert.equal(
      marker.signature,
      "native-plugin-zh@native-plugin-zh-local:found=false",
      "补偿完成前不得提前把停机期间的新状态标记为已处理",
    );
    const applied = await waitFor(
      () => readManifestInterface().shortDescription === chinese,
      4000,
    );
    assert.equal(applied, true, "启动时应补齐停机期间发生的启用切换");
    const settled = JSON.parse(
      fs.readFileSync(path.join(dataDir, "last-switch.json"), "utf8"),
    );
    assert.equal(
      settled.signature,
      "native-plugin-zh@native-plugin-zh-local:found=true",
      "补偿完成后应持久化新的开关状态",
    );
  } finally {
    stop();
  }
});

test("startup does not invent a transition when the persisted state matches", async () => {
  writeConfig(true);
  writeManifest("english");
  seedState();
  fs.writeFileSync(
    path.join(dataDir, "last-switch.json"),
    `${JSON.stringify({
      signature: "native-plugin-zh@native-plugin-zh-local:found=true",
      found: true,
      enabled: true,
    })}\n`,
    "utf8",
  );

  const { startConfigWatcher } = await import("../lib/watcher.mjs");
  const stop = startConfigWatcher({ pollMs: 60 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(
      readManifestInterface().shortDescription,
      english,
      "状态一致时不应重新写入中文",
    );
  } finally {
    stop();
  }
});
