import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-restore-server-"));
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
      ? { displayName: "浏览器", shortDescription: chinese, longDescription: "浏览网页" }
      : { displayName: "Browser", shortDescription: english, longDescription: "Browse the web" };
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
    lastPluginConfigEnabled: false,
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
  });
}

function readInterface() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")).interface;
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// 模拟 Codex 启动用户级 MCP 服务器：initialize -> initialized -> 自动恢复。
function spawnRestoreServer(scriptOverride = null) {
  const script =
    scriptOverride || path.resolve(import.meta.dirname, "..", "scripts", "restore-server.mjs");
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_PLUGIN_ZH_DATA_DIR: dataDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.on("data", () => {});
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "codex", version: "test" }, capabilities: null },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return child;
}

test("restore server repairs English when disabled and no-ops when enabled", async () => {
  // 场景一：插件开关关闭、清单是中文 -> 启动后应自动恢复英文
  writeConfig(false);
  writeManifest("chinese");
  seedState();
  let child = spawnRestoreServer();
  const restored = await waitFor(
    () => readInterface().displayName === "Browser" && readInterface().shortDescription === english,
  );
  child.kill();
  assert.equal(restored, true, "禁用状态下 restore-server 应在启动后恢复英文");

  // 场景二：插件开关启用 -> restore-server 不应触碰清单
  writeConfig(true);
  writeManifest("chinese");
  seedState();
  child = spawnRestoreServer();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  child.kill();
  assert.equal(readInterface().displayName, "浏览器", "启用状态下 restore-server 不应改动清单");
  assert.equal(readInterface().shortDescription, chinese);
});

test("the deployed bin copy of restore-server works standalone", async () => {
  const { syncRestoreServerBin } = await import("../lib/registration.mjs");
  assert.equal(syncRestoreServerBin(), true);
  const binScript = path.join(dataDir, "bin", "restore-server.mjs");
  const source = fs.readFileSync(binScript, "utf8");
  assert.doesNotMatch(source, /from "\.\.\/lib\//, "bin 副本不得引用上级目录的 lib");

  writeConfig(false);
  writeManifest("chinese");
  seedState();
  const child = spawnRestoreServer(binScript);
  const restored = await waitFor(
    () => readInterface().displayName === "Browser" && readInterface().shortDescription === english,
  );
  child.kill();
  assert.equal(restored, true, "bin 副本（Codex 实际拉起的入口）应能完成恢复");
});
