// 用户级 MCP 服务器：独立于插件启停状态的英文恢复兜底。
//
// 由 bootstrap 注册到 config.toml 的 [mcp_servers.native_plugin_zh_restore]，
// Codex 每次启动都会拉起它（无论插件是否被禁用）。行为只有一个：
//   插件开关处于启用状态 -> 什么都不做；
//   插件开关处于关闭/缺失 -> 按备份恢复英文原值。
// 恢复只写 state.plugins 记录过的字段，从不触碰其他内容；不做任何中文写入。
import readline from "node:readline";

import { APP_VERSION, logLine } from "../lib/paths.mjs";
import { readPluginConfigState } from "../lib/lifecycle.mjs";
import { restoreOriginals } from "../lib/sync.mjs";
import { startConfigWatcher } from "../lib/watcher.mjs";

const SERVER_NAME = "native_plugin_zh_restore";
const TOOLS = [
  {
    name: "native_zh_restore_check",
    title: "检查并执行英文恢复",
    description:
      "如果原生插件中文化插件处于关闭状态，立即把插件清单恢复为备份的英文原值；启用状态则不做任何事。",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: true,
    },
  },
];

let restoreRan = false;

async function restoreIfDisabled(trigger) {
  if (restoreRan) return null;
  restoreRan = true;
  const config = readPluginConfigState();
  if (config.enabled) {
    logLine(`restore-server(${trigger}): 插件开关已启用，跳过恢复。`);
    return { skipped: true, reason: "plugin-enabled" };
  }
  const result = await restoreOriginals({
    preserveIntent: true,
    onlyIfOverlayActive: false,
    lastPluginConfigEnabled: false,
    requirePluginDisabled: true,
    recordNoop: false,
    reason: config.found ? "restore-server" : "restore-server-config-missing",
    trigger,
    lockWaitMs: 5000,
    quiet: true,
  });
  logLine(
    `restore-server(${trigger}): ${
      result?.skipped ? `skip-${result.reason}` : "done"
    } restored=${result?.restoredFields || 0} conflicts=${result?.conflicts?.length || 0} errors=${
      result?.errors?.length || 0
    }`,
  );
  return result;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function dispatch(message) {
  const { id, method, params } = message;
  if (!method) {
    if (id !== undefined) sendError(id, -32600, "Invalid Request");
    return;
  }
  if (id === undefined) {
    if (method === "notifications/initialized") {
      void restoreIfDisabled("initialized").catch((error) => {
        logLine(`restore-server 恢复失败：${error.stack || error.message}`);
      });
    }
    return;
  }
  try {
    if (method === "initialize") {
      sendResult(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: APP_VERSION },
        instructions:
          "原生插件中文化的英文恢复兜底。插件开关关闭时在启动后自动恢复英文；启用时不做任何事。",
      });
      return;
    }
    if (method === "ping" || method === "logging/setLevel") {
      sendResult(id, {});
      return;
    }
    if (method === "tools/list") {
      sendResult(id, { tools: TOOLS });
      return;
    }
    if (method === "tools/call" && params?.name === "native_zh_restore_check") {
      restoreRan = false;
      void restoreIfDisabled("tool")
        .then((result) => {
          const fields = result?.restoredFields || 0;
          const conflicts = result?.conflicts?.length || 0;
          const text = result?.skipped
            ? `跳过：${result.reason === "plugin-enabled" ? "插件开关已启用" : result.reason}。`
            : `已恢复 ${fields} 个字段，跳过冲突 ${conflicts}。`;
          sendResult(id, {
            content: [{ type: "text", text }],
            structuredContent: result || {},
          });
        })
        .catch((error) => {
          sendResult(id, {
            content: [{ type: "text", text: `恢复失败：${error.message}` }],
            isError: true,
          });
        });
      return;
    }
    sendError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    if (id !== undefined) sendError(id, -32603, error.message);
  }
}

function main() {
  logLine(`restore-server 启动 pid=${process.pid}`);
  // 用户级服务器全程存活，是唯一能覆盖“启用/禁用两个方向”的监听者：
  // 切换 -> 写清单 -> 自动重启 Codex（settings.autoRestartApp = false 可关闭）。
  startConfigWatcher({ autoRestart: true });
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      sendError(null, -32700, "Parse error");
      return;
    }
    if (Array.isArray(message)) {
      for (const item of message) dispatch(item);
    } else {
      dispatch(message);
    }
  });
  input.on("close", () => process.exit(0));
  process.once("SIGINT", () => process.exit(0));
  process.once("SIGTERM", () => process.exit(0));
}

main();
