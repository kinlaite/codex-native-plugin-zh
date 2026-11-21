import { logLine } from "./paths.mjs";
import { appendHistory, readPluginConfigState } from "./lifecycle.mjs";
import { endLifecycle, startLifecycle } from "./runtime.mjs";
import { loadState } from "./storage.mjs";

function recordHook(record) {
  appendHistory({ action: "hook", ...record });
}

export async function runHookEvent(event, input = {}) {
  const startedAt = Date.now();
  const config = readPluginConfigState();
  const state = loadState();
  const base = {
    event,
    pluginEnabled: config.enabled,
    overlayActive: state.overlayActive === true,
    intentEnabled: state.enabled === true,
    sessionId: input?.session_id || null,
    reason: input?.reason || input?.source || null,
  };

  if (event === "SessionStart") {
    const result = await startLifecycle({
      reason: "codex-session-start",
      trigger: "SessionStart",
      lockWaitMs: 5000,
    });
    recordHook({
      ...base,
      result:
        result?.action === "skip"
          ? result.reason
          : result?.skipped
            ? "skip-locked"
            : "applied",
      changedPlugins: result?.changedPlugins || 0,
      appliedFields: result?.appliedFields || 0,
      restoredFields: result?.restoredFields || 0,
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  }

  if (event === "SessionEnd") {
    const result = await endLifecycle({
      trigger: "SessionEnd",
      lockWaitMs: 2000,
    });
    recordHook({
      ...base,
      result:
        result?.action === "keep"
          ? "keep-plugin-enabled"
          : result?.skipped
            ? "skip-locked"
            : "restored",
      restoredPlugins: result?.restoredPlugins || 0,
      restoredFields: result?.restoredFields || 0,
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  }

  return { action: "skip", reason: "unknown-event" };
}

export async function hookMain(event) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
    setTimeout(finish, 120);
  });
  let parsed = {};
  try {
    parsed = input.trim() ? JSON.parse(input) : {};
  } catch {}
  try {
    const result = await runHookEvent(event, parsed);
    logLine(
      `hook ${event}: ${result?.action || "done"} ${
        result?.appliedFields !== undefined ? `fields=${result.appliedFields}` : ""
      } ${result?.restoredFields !== undefined ? `restored=${result.restoredFields}` : ""}`,
    );
  } catch (error) {
    logLine(`hook ${event} 失败：${error.stack || error.message}`);
    recordHook({
      event,
      result: "error",
      message: error.message,
    });
  }
}
