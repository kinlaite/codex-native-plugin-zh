import readline from "node:readline";

import { APP_VERSION, logLine } from "./lib/paths.mjs";
import {
  autoTranslatePending,
  autoTranslateUpdatesEnabled,
  catalogStatus,
  startCatalogWatcher,
} from "./lib/catalog.mjs";
import {
  bootstrap,
  diagnose,
  purgeDataAfterRestore,
} from "./lib/maintenance.mjs";
import { readPluginConfigState } from "./lib/lifecycle.mjs";
import { removeRestoreServerRegistration } from "./lib/registration.mjs";
import { endLifecycle } from "./lib/runtime.mjs";
import { startConfigWatcher } from "./lib/watcher.mjs";
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
      "查看 Codex 原生插件中文覆盖是否启用、待写入字段、待翻译字段、自动增量翻译和后台清单监听状态。",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "native_zh_apply",
    title: "立即写入中文",
    description:
      "启用中文化偏好，并立即把已有中文翻译写入 Codex 实际读取的插件来源清单。关闭插件后，运行中的服务器会自动恢复英文，重启 Codex 即可看到结果。",
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
      "立即重新发现本地 marketplace 插件来源和 Git 插件的已安装缓存并同步中文。英文未变的字段复用缓存，只翻译新增或变化字段；日常更新通常已由后台自动完成。",
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
    title: "手动恢复英文并暂停中文化",
    description:
      "把已覆盖的插件字段恢复为修改前的原值，并暂停中文化。普通重启不会重新写入；只有再次调用 native_zh_apply，或先关闭再重新启用插件，才会恢复中文化。",
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
    name: "native_zh_uninstall",
    title: "卸载中文化并恢复英文",
    description:
      "先恢复全部英文并暂停中文化。翻译缓存、状态和备份默认保留，便于追溯；不会删除 Codex 本体或插件安装缓存。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        purge: {
          type: "boolean",
          description: "删除运行数据、翻译缓存和备份，默认 false。",
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
    name: "native_zh_diagnose",
    title: "诊断插件生命周期",
    description:
      "检查 Codex 插件开关、中文覆盖、自动增量翻译、后台清单监听、恢复 MCP、hooks 信任记录、Codex/Node 定位和同步错误。",
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
let catalogStarted = false;

export function startBootstrap() {
  bootstrapPromise ??= bootstrap()
    .then((result) => {
      logLine(
        `MCP bootstrap 完成 fields=${result.lifecycle?.appliedFields || 0} restored=${
          result.lifecycle?.restoredFields || 0
        }`,
      );
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

function startCatalogBackground(boot) {
  if (catalogStarted || process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP === "1") return;
  catalogStarted = true;

  void startCatalogWatcher().catch((error) => {
    logLine(`catalog: 启动监听失败：${error.stack || error.message}`);
  });

  if (!autoTranslateUpdatesEnabled()) {
    logLine("catalog: 自动增量翻译已在 settings.json 中关闭");
    return;
  }
  const disabledForIntent =
    boot?.config?.enabled === false ||
    (boot?.lifecycle?.action === "skip" && boot?.lifecycle?.reason === "intent-disabled");
  if (disabledForIntent) return;

  // 每次启动都做一次后台扫描：bootstrap 与监听器基线之间若恰好新增插件，
  // 也能靠这次扫描补上；没有待翻译字段时只扫描、不调用模型。
  const runStartupTranslation = (attempt) => {
    void autoTranslatePending({ reason: "startup-pending", lockWaitMs: 15000 })
      .then((result) => {
        if (
          result?.skipped &&
          result.disabled !== true &&
          result.reason !== "disabled-by-settings" &&
          attempt < 3
        ) {
          logLine(
            `catalog startup-pending: 跳过（${result.reason || "locked"}），稍后重试`,
          );
          scheduleStartupTranslation(attempt + 1, attempt * 30000);
          return;
        }
        logLine(
          result?.skipped
            ? `catalog startup-pending: 跳过（${result.reason || "locked"}）`
            : `catalog startup-pending: applied=${result?.appliedFields || 0} translated=${
                result?.translation?.translated || 0
              } pending=${result?.pending?.length || 0}`,
        );
      })
      .catch((error) => {
        logLine(`catalog startup-pending 失败：${error.stack || error.message}`);
        if (attempt < 3) scheduleStartupTranslation(attempt + 1, attempt * 30000);
      });
  };
  const scheduleStartupTranslation = (attempt, delay) => {
    const timer = setTimeout(() => runStartupTranslation(attempt), delay);
    timer.unref?.();
  };
  scheduleStartupTranslation(1, 1800);
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
  const boot = await waitForBootstrap();
  const summary = await syncWithTranslation({
    dryRun: args.dryRun === true,
    enable: args.dryRun !== true,
    lastPluginConfigEnabled:
      args.dryRun === true ? undefined : readPluginConfigState().enabled,
    autoTranslate: args.autoTranslate !== false,
    quiet: true,
    allowAppServer: false,
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
    structuredContent: { ...summary, bootstrap: boot?.skipped ? boot : undefined },
  };
}

async function handleSync(args = {}) {
  await waitForBootstrap();
  const summary = await syncWithTranslation({
    dryRun: args.dryRun === true,
    autoTranslate: args.autoTranslate !== false,
    quiet: true,
    scope: args.installedOnly === true ? "installed-only" : "all-local",
    allowAppServer: false,
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
  const result = await restoreOriginals({
    force: args.force === true,
    preserveIntent: false,
    lastPluginConfigEnabled: readPluginConfigState().enabled,
    reason: "manual-tool",
    trigger: "mcp",
    quiet: true,
  });
  return {
    content: [
      {
        type: "text",
        text: result.skipped
          ? "已有同步进程在运行，本次恢复跳过。"
          : `已恢复 ${result.restoredPlugins} 个插件、${result.restoredFields} 个字段；中文化已暂停。跳过冲突 ${result.conflicts.length}，错误 ${result.errors.length}。`,
      },
    ],
    structuredContent: result,
  };
}

async function handleStatus() {
  await waitForBootstrap();
  const result = await status({ json: false, quiet: true });
  const catalog = catalogStatus();
  return {
    content: [
      {
        type: "text",
        text: `中文化偏好${result.enabled ? "已启用" : "已暂停"}；中文覆盖${
          result.overlayActive ? "已生效" : "未生效"
        }；Codex 插件开关${result.pluginConfig.enabled ? "已启用" : "已关闭"}；本地插件 ${
          result.localPlugins
        }，待写入 ${result.plannedFields} 字段，待翻译 ${result.pending.length}，跳过中文源 ${
          result.alreadyChineseFields
        }；自动增量翻译${
          result.autoTranslateUpdates ? "已开启" : "已关闭"
        }，后台清单监听${
          catalog.watcherActive ? "运行中" : "未启动"
        }。关闭插件后由运行中的服务器自动恢复英文，重启 Codex 即可生效。`,
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
  if (name === "native_zh_uninstall") {
    await waitForBootstrap();
    const restored = await restoreOriginals({
      preserveIntent: false,
      lastPluginConfigEnabled: readPluginConfigState().enabled,
      reason: "uninstall",
      trigger: "mcp",
      quiet: true,
    });
    removeRestoreServerRegistration();
    const purgeResult = purgeDataAfterRestore(restored, {
      purge: args.purge === true,
    });
    return {
      content: [
        {
          type: "text",
          text: `已恢复 ${restored.restoredPlugins} 个插件、${
            restored.restoredFields
          } 个字段；${
            purgeResult.purged
              ? "缓存和备份已清除"
              : purgeResult.reason === "not-requested"
                ? "翻译缓存与备份已保留"
                : `清理已阻止（${purgeResult.reason}），恢复数据仍保留`
          }。`,
        },
      ],
      structuredContent: { restored, ...purgeResult },
    };
  }
  if (name === "native_zh_diagnose") {
    await waitForBootstrap();
    const result = await diagnose({ json: false, quiet: true });
    return {
      content: [
        {
          type: "text",
          text: `Codex 插件开关${
            result.pluginConfig.enabled ? "已启用" : "已关闭"
          }；中文覆盖${result.overlayActive ? "已生效" : "未生效"}；hooks ${
            result.hookTrust.configured ? "已有信任记录" : "待批准"
          }；关闭监听${result.watcher?.available ? "可用" : "受限（仅轮询）"}；发现方式 ${
            result.sync.discoverySource || "未知"
          }，待翻译 ${result.sync.pending}，错误 ${result.sync.errors.length}。`,
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
          "维护 Windows 版 Codex 原生插件 UI 的中文清单覆盖层，单插件自闭环：插件启用后由 hooks 或 MCP 写入中文；后台监听本地 marketplace 源与 Git 插件的已安装缓存，Codex 更新、目标插件更新或新装本地/Git 插件后只翻译新增和英文变化的字段；插件关闭后由运行中的监听器和 config.toml 注册的用户级恢复 MCP 恢复英文。切换开关可自动重启 Codex，WMI 重启助手独立运行且不显示控制台窗口。不安装计划任务或独立外部服务，不修改 Codex 本体。优先使用 native_zh_diagnose、native_zh_apply 和 native_zh_sync。",
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

// 进程被 Codex 回收前的最后机会：如果此刻插件已被关闭而监听器还没来得及
// 恢复英文，就在退出前完成恢复。插件仍启用时这是零写入的空检查。
let shutdownHandled = false;
async function shutdownLastChance(trigger) {
  if (shutdownHandled) return;
  shutdownHandled = true;
  try {
    await Promise.race([
      endLifecycle({ trigger, lockWaitMs: 0, quiet: true }),
      new Promise((resolve) => setTimeout(resolve, 7000)),
    ]);
  } catch {}
}

function main() {
  // 先让 bootstrap 完成一次 reconcile 再启动监听器：启动期间若已发生切换，
  // 监听器会通过 last-switch.json 检测到，并且不会和 bootstrap 争抢同步锁。
  void startBootstrap().then((boot) => {
    // 与用户级恢复服务器各有一个监听器：两者看到同一次切换时，restart.mjs
    // 会按开关状态签名去重，只重启一次。插件进程被硬杀时由恢复服务器兜底。
    startConfigWatcher({ autoRestart: true });
    startCatalogBackground(boot);
  });
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
  input.on("close", () => {
    void shutdownLastChance("mcp-stdin-close").finally(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    void shutdownLastChance("sigint").finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdownLastChance("sigterm").finally(() => process.exit(0));
  });
}

main();
