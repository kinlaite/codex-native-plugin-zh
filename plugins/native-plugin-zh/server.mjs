import readline from "node:readline";

import { APP_VERSION, logLine } from "./lib/paths.mjs";
import { bootstrap, diagnose, installAutoSync, uninstallAutoSync } from "./lib/tasks.mjs";
import {
  restoreOriginals,
  status,
  syncWithTranslation,
} from "./lib/sync.mjs";

const SERVER_NAME = "native_plugin_zh";
const TOOLS = [
  {
    name: "native_zh_status",
    title: "查看原生插件中文化状态",
    description:
      "查看 Codex 原生插件中文覆盖是否启用、待写入字段、待翻译字段和上次同步结果。",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "native_zh_apply",
    title: "立即写入中文",
    description:
      "启用自动覆盖，并立即把已有中文翻译写入 Codex 实际读取的插件来源清单。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        autoTranslate: {
          type: "boolean",
          description: "是否对新增或变化字段调用 Codex 增量翻译，默认 true。",
        },
        dryRun: {
          type: "boolean",
          description: "仅预览将修改的内容，默认 false。",
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "native_zh_sync",
    title: "同步原生插件中文",
    description:
      "重新发现本地插件来源并同步中文。英文未变的字段复用缓存，只翻译新增或变化字段。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        autoTranslate: {
          type: "boolean",
          description: "是否自动增量翻译待处理字段，默认 true。",
        },
        dryRun: {
          type: "boolean",
          description: "仅扫描和预览，不写清单，默认 false。",
        },
        installedOnly: {
          type: "boolean",
          description: "只处理已安装插件，默认 false。",
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "native_zh_restore",
    title: "恢复原始英文清单",
    description:
      "把已覆盖的插件字段恢复为修改前的原值，并暂停自动同步。默认跳过同步期间被外部改写的字段。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        force: {
          type: "boolean",
          description: "强制恢复备份中的旧原值，默认 false。",
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "native_zh_install_autosync",
    title: "安装自动同步任务",
    description:
      "安装或修复登录触发、每 5 分钟运行的 Windows 计划任务。任务指向独立稳定运行目录。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        force: {
          type: "boolean",
          description: "即使已存在也重新创建任务，默认 false。",
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "native_zh_uninstall_autosync",
    title: "删除自动同步任务",
    description: "删除 Windows 计划任务。不会删除翻译缓存、备份或已写入的中文。",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "native_zh_diagnose",
    title: "诊断更新韧性",
    description:
      "检查稳定运行目录、Codex 与 Node 定位、计划任务、发现方式和同步错误，用于插件或 Codex 更新后排查。",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
  },
];

const toolMap = new Map(TOOLS.map((tool) => [tool.name, tool]));
let bootstrapPromise = null;

export function startBootstrap() {
  bootstrapPromise ??= bootstrap({ syncCached: true })
    .then((result) => {
      logLine(`MCP bootstrap 完成 runtime=${result.runtime.copied} task=${result.task?.recreated}`);
      return result;
    })
    .catch((error) => {
      logLine(`MCP bootstrap 失败：${error.stack || error.message}`);
      return { error: error.message };
    });
  return bootstrapPromise;
}

async function waitForBootstrap() {
  return startBootstrap();
}

function pendingPreview(summary) {
  const pending = summary.pending || [];
  if (!pending.length) return "";
  const preview = pending
    .slice(0, 12)
    .map((item) => `${item.key}/${item.field}`)
    .join("、");
  return pending.length > 12 ? `；${preview} 等 ${pending.length} 项` : `；${preview}`;
}

async function handleApply(args = {}) {
  await waitForBootstrap();
  const summary = await syncWithTranslation({
    dryRun: args.dryRun === true,
    enable: args.dryRun !== true,
    autoTranslate: args.autoTranslate !== false,
    quiet: true,
  });
  const text = summary.skipped
    ? "已有同步进程在运行，本次跳过。"
    : summary.disabled
      ? "自动同步未启用。"
      : `${args.dryRun ? "预览" : "已写入"} ${summary.changedPlugins} 个插件、${
          summary.appliedFields
        } 个字段；待翻译 ${summary.pending.length} 个${pendingPreview(summary)}。`;
  return {
    content: [{ type: "text", text }],
    structuredContent: summary,
  };
}

async function handleSync(args = {}) {
  await waitForBootstrap();
  const summary = await syncWithTranslation({
    dryRun: args.dryRun === true,
    autoTranslate: args.autoTranslate !== false,
    quiet: true,
    scope: args.installedOnly === true ? "installed-only" : "all-local",
  });
  const translated = summary.translation?.translated || 0;
  const text = summary.skipped
    ? "已有同步进程在运行，本次跳过。"
    : summary.disabled
      ? "自动同步已暂停。调用 native_zh_apply 可重新启用。"
      : `${args.dryRun ? "预览" : "同步完成"}：${summary.changedPlugins} 个插件、${
          summary.appliedFields
        } 个字段；新增翻译 ${translated}；剩余待翻译 ${summary.pending.length}${pendingPreview(summary)}。`;
  return {
    content: [{ type: "text", text }],
    structuredContent: summary,
  };
}

async function handleRestore(args = {}) {
  await waitForBootstrap();
  const result = await restoreOriginals({ force: args.force === true, quiet: true });
  return {
    content: [
      {
        type: "text",
        text: result.skipped
          ? "已有同步进程在运行，本次恢复跳过。"
          : `已恢复 ${result.restoredPlugins} 个插件、${result.restoredFields} 个字段；自动同步已暂停。跳过冲突 ${result.conflicts.length}，错误 ${result.errors.length}。`,
      },
    ],
    structuredContent: result,
  };
}

async function handleInstall(args = {}) {
  await waitForBootstrap();
  const result = installAutoSync({ force: args.force === true });
  return {
    content: [
      {
        type: "text",
        text: `${result.recreated ? "已重新创建" : "自动同步任务已正常"}：${
          result.taskName
        }；稳定同步脚本 ${result.script || result.action}。`,
      },
    ],
    structuredContent: result,
  };
}

async function handleStatus() {
  await waitForBootstrap();
  const result = await status({ json: false, quiet: true });
  return {
    content: [
      {
        type: "text",
        text: `自动中文化${result.enabled ? "已启用" : "已暂停"}；本地插件 ${
          result.localPlugins
        }，待写入 ${result.plannedFields} 字段，待翻译 ${result.pending.length}，跳过中文源 ${
          result.alreadyChineseFields
        }。`,
      },
    ],
    structuredContent: result,
  };
}

async function callTool(name, args) {
  if (name === "native_zh_status") return handleStatus();
  if (name === "native_zh_apply") return handleApply(args);
  if (name === "native_zh_sync") return handleSync(args);
  if (name === "native_zh_restore") return handleRestore(args);
  if (name === "native_zh_install_autosync") return handleInstall(args);
  if (name === "native_zh_uninstall_autosync") {
    await waitForBootstrap();
    const result = uninstallAutoSync();
    return {
      content: [{ type: "text", text: `已删除计划任务 ${result.taskName}。` }],
      structuredContent: result,
    };
  }
  if (name === "native_zh_diagnose") {
    await waitForBootstrap();
    const result = await diagnose({ json: false, quiet: true });
    return {
      content: [
        {
          type: "text",
          text: `任务${result.task.exists ? "已安装" : "缺失"}，自愈检查${
            result.task.ok ? "正常" : "异常"
          }，动作${result.task.actionMatches ? "正常" : "异常"}，触发器${
            result.task.triggersOk ? "正常" : "异常"
          }；发现方式 ${result.sync.discoverySource || "未知"}，待翻译 ${
            result.sync.pending
          }，错误 ${result.sync.errors.length}。`,
        },
      ],
      structuredContent: result,
    };
  }
  throw new Error(`未知工具：${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data = undefined) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

async function dispatch(message) {
  const { id, method, params } = message;
  if (!method) {
    if (id !== undefined) sendError(id, -32600, "Invalid Request");
    return;
  }
  if (id === undefined) {
    if (method === "notifications/initialized") startBootstrap();
    return;
  }

  try {
    if (method === "initialize") {
      sendResult(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: APP_VERSION },
        instructions:
          "维护 Codex 原生插件 UI 的中文清单覆盖层。优先使用 native_zh_diagnose、native_zh_apply 和 native_zh_sync。",
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
    if (method === "tools/call") {
      const name = params?.name;
      if (!toolMap.has(name)) {
        sendError(id, -32602, `未知工具：${name}`);
        return;
      }
      try {
        sendResult(id, await callTool(name, params?.arguments || {}));
      } catch (error) {
        logLine(`工具 ${name} 失败：${error.stack || error.message}`);
        sendResult(id, {
          content: [{ type: "text", text: error.message }],
          isError: true,
        });
      }
      return;
    }
    if (method === "resources/list") {
      sendResult(id, { resources: [] });
      return;
    }
    if (method === "prompts/list") {
      sendResult(id, { prompts: [] });
      return;
    }
    sendError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    sendError(id, -32603, error.message);
  }
}

function main() {
  startBootstrap();
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
      for (const item of message) void dispatch(item);
    } else {
      void dispatch(message);
    }
  });
  input.on("close", () => process.exit(0));
}

main();
