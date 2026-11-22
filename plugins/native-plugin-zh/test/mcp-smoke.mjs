import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-plugin-zh-mcp-"));
const codexHome = path.join(tempRoot, "codex-home");
const dataDir = path.join(tempRoot, "plugin-i18n-native");
const marketplaceRoot = path.join(tempRoot, "marketplace");
const pluginRoot = path.join(marketplaceRoot, "plugins", "smoke-plugin");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      name: "smoke-plugin",
      version: "1.0.0",
      interface: {
        displayName: "冒烟测试插件",
        shortDescription: "用于验证 MCP 启动和后台监听",
        longDescription: "该插件只存在于临时目录，不会触碰真实 Codex 数据。",
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
fs.writeFileSync(
  path.join(codexHome, "config.toml"),
  [
    '[plugins."native-plugin-zh@native-plugin-zh-local"]',
    "enabled = true",
    "",
    "[marketplaces.smoke-local]",
    'source_type = "local"',
    `source = '${marketplaceRoot.replaceAll("\\", "/")}'`,
    "",
  ].join("\n"),
  "utf8",
);
const childEnv = {
  ...process.env,
  CODEX_HOME: codexHome,
  CODEX_PLUGIN_ZH_DATA_DIR: dataDir,
  USERPROFILE: tempRoot,
  HOME: tempRoot,
};
delete childEnv.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP;
const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: childEnv,
});

const pending = new Map();
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

let nextId = 1;
function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timeout: ${method}`));
    }, 60000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "smoke", version: "1.0.0" },
    capabilities: {},
  });
  assert.equal(initialized.serverInfo.name, "native_plugin_zh");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const tools = await request("tools/list");
  assert.ok(tools.tools.some((tool) => tool.name === "native_zh_status"));
  assert.ok(tools.tools.some((tool) => tool.name === "native_zh_apply"));

  const status = await request("tools/call", {
    name: "native_zh_status",
    arguments: {},
  });
  assert.equal(status.isError, undefined);
  assert.ok(status.structuredContent.localPlugins > 0);
  assert.equal(
    await waitFor(() => fs.existsSync(path.join(dataDir, "catalog-state.json"))),
    true,
    "后台插件清单监听应启动并写入 catalog-state.json",
  );
  const catalogState = JSON.parse(
    fs.readFileSync(path.join(dataDir, "catalog-state.json"), "utf8"),
  );
  assert.equal(catalogState.plugins, 1);
  assert.equal(typeof catalogState.fingerprint, "string");
  console.log(
    `MCP smoke passed: ${tools.tools.length} tools, ${status.structuredContent.localPlugins} plugins, catalog watcher=${catalogState.plugins}`,
  );
} finally {
  child.kill();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
