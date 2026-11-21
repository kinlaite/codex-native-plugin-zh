// 插件开关监听器。
//
// 运行在主插件自己的 MCP 服务器进程内：Codex 禁用插件会移除 hooks 和 MCP 的
// “下一次”启动，但不会立刻终结正在运行的服务器进程。因此只要用户在 Codex
// 里把插件开关拨到关闭，本进程能在数秒内发现 config.toml 变化并立即恢复英文，
// 不再依赖第二个“守护”插件。
//
// 三层触发：fs.watch（文件与所在目录，覆盖原子替换）、低频轮询兜底、以及
// server.mjs 在 stdin 关闭（进程被回收）前的最后机会检查。
import fs from "node:fs";
import path from "node:path";

import {
  CODEX_HOME,
  DATA_DIR,
  logLine,
  nowIso,
  readJson,
  writeJsonAtomic,
} from "./paths.mjs";
import { appendHistory, readPluginConfigState } from "./lifecycle.mjs";
import { requestAndLaunchAppRestart } from "./restart.mjs";
import { startLifecycle } from "./runtime.mjs";

const CONFIG_FILE = path.join(CODEX_HOME, "config.toml");
const SWITCH_FILE = path.join(DATA_DIR, "last-switch.json");

let started = false;

function readSwitch() {
  const config = readPluginConfigState();
  return {
    found: config.found === true,
    enabled: config.enabled === true,
    signature: `${config.pluginId}:${config.found ? "found" : "missing"}=${config.enabled}`,
  };
}

// Codex 在启用插件时会重启用户级 MCP 服务器。新进程启动时开关已经是
// “启用”，如果不记录上一次观察值，就完全看不到这次切换。把最后状态
// 持久化，启动时对比即可补上“停机期间发生的变化”。
function readPersistedSwitch() {
  const value = readJson(SWITCH_FILE, null);
  return value && typeof value.signature === "string" ? value : null;
}

function persistSwitch(state) {
  try {
    writeJsonAtomic(SWITCH_FILE, { at: nowIso(), ...state });
  } catch (error) {
    logLine(`watch: 写入开关状态失败：${error.message}`);
  }
}

async function react(trigger, previous, next, { autoRestart }) {
  const result = await startLifecycle({
    reason: next.enabled ? "plugin-enabled" : "plugin-disabled",
    trigger,
    lockWaitMs: 8000,
    quiet: true,
  });
  const appliedFields = result?.appliedFields || result?.changedPlugins;
  const restoredFields = result?.restoredFields;
  appendHistory({
    action: "watch",
    event: trigger,
    from: previous.signature,
    to: next.signature,
    result: result?.skipped ? `skip-${result.reason || "locked"}` : result?.action || "done",
    ...(appliedFields !== undefined ? { appliedFields } : {}),
    ...(restoredFields !== undefined ? { restoredFields } : {}),
  });
  logLine(
    `watch ${trigger}: ${previous.signature} -> ${next.signature} ` +
      `applied=${appliedFields ?? "-"} restored=${restoredFields ?? "-"}`,
  );
  // 清单已写对；自动重启让 Codex 立即重新读取插件目录并显示新语言。
  // reconcile 被锁跳过时不重启——持锁的另一方看到了同一次切换，由它负责。
  if (autoRestart && !result?.skipped && result?.action !== "skip") {
    const decision = requestAndLaunchAppRestart({
      reason: `watch-${trigger}`,
      signature: next.signature,
    });
    if (!decision.allowed) logLine(`restart: 跳过（${decision.reason}）`);
  }
  // 只有动作完成后才更新持久化状态。这样进程若在启动补偿途中被 Codex
  // 回收，下一个 MCP 进程仍能从旧签名识别出这次切换并重试。
  if (!result?.skipped) persistSwitch(next);
  return result;
}

export function startConfigWatcher({ pollMs = 2000, autoRestart = false } = {}) {
  if (started) return () => {};
  started = true;

  const persisted = readPersistedSwitch();
  let current = readSwitch();
  if (!persisted || persisted.signature === current.signature) persistSwitch(current);
  let busy = false;
  let queuedTrigger = null;

  async function check(trigger, previousOverride = null) {
    if (busy) {
      queuedTrigger = trigger;
      return;
    }
    const next = readSwitch();
    const previous = previousOverride || current;
    if (next.signature === previous.signature) return;
    busy = true;
    current = next;
    let result;
    try {
      result = await react(trigger, previous, next, { autoRestart });
    } catch (error) {
      current = previous;
      logLine(`watch ${trigger} 失败：${error.stack || error.message}`);
    } finally {
      busy = false;
      if (result?.skipped) current = previous;
      if (queuedTrigger) {
        const retry = queuedTrigger;
        queuedTrigger = null;
        void check(retry);
      }
    }
  }

  const dispose = [];
  try {
    const watcher = fs.watch(CONFIG_FILE, () => void check("fswatch-file"));
    watcher.on("error", () => watcher.close());
    dispose.push(watcher);
  } catch {}
  try {
    const dirWatcher = fs.watch(path.dirname(CONFIG_FILE), (_event, filename) => {
      if (!filename || String(filename).toLowerCase().includes("config")) {
        void check("fswatch-dir");
      }
    });
    dirWatcher.on("error", () => dirWatcher.close());
    dispose.push(dirWatcher);
  } catch {}
  const timer = setInterval(() => void check("poll"), Math.max(500, pollMs));
  timer.unref?.();

  logLine(
    `watch: 已开始监听插件开关（${CONFIG_FILE}，当前 ${current.signature}` +
      (persisted ? `，上次 ${persisted.signature}` : "，无历史状态") +
      "）",
  );
  if (persisted && persisted.signature !== current.signature) {
    logLine(`watch: 检测到停机期间开关变化 ${persisted.signature} -> ${current.signature}`);
    setTimeout(() => void check("startup-transition", persisted), 0);
  }
  return () => {
    for (const item of dispose) {
      try {
        item.close();
      } catch {}
    }
    clearInterval(timer);
    started = false;
  };
}

export { CONFIG_FILE as WATCHED_CONFIG_FILE };
