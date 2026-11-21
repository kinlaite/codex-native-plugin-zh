import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-plugin-zh-mcp-"));
const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    CODEX_PLUGIN_ZH_DATA_DIR: tempDir,
    CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP: "1",
    CODEX_PLUGIN_ZH_NO_TASK: "1",
  },
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
  console.log(
    `MCP smoke passed: ${tools.tools.length} tools, ${status.structuredContent.localPlugins} plugins`,
  );
} finally {
  child.kill();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
