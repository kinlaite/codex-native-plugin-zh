import { appendHistory, readPluginConfigState } from "./lifecycle.mjs";
import { logLine } from "./paths.mjs";
import { loadState } from "./storage.mjs";
import { restoreOriginals } from "./sync.mjs";

export async function runGuardSessionStart() {
  if (process.env.CODEX_PLUGIN_ZH_DISABLE_GUARD === "1") {
    return { action: "skip", reason: "disabled-by-env" };
  }

  const config = readPluginConfigState();
  if (config.enabled) {
    return { action: "skip", reason: "main-enabled" };
  }

  const state = loadState();
  const startedAt = Date.now();
  const result = await restoreOriginals({
    preserveIntent: true,
    onlyIfOverlayActive: false,
    lastPluginConfigEnabled: false,
    requirePluginDisabled: true,
    recordNoop: false,
    reason: config.found ? "main-plugin-disabled" : "main-plugin-missing",
    trigger: "guard-SessionStart",
    lockWaitMs: 5000,
    quiet: true,
  });

  const restoredFields = result?.restoredFields || 0;
  const conflicts = result?.conflicts?.length || 0;
  const errors = result?.errors?.length || 0;
  const recorded =
    restoredFields > 0 ||
    conflicts > 0 ||
    errors > 0 ||
    (result?.recoveredBackupEntries || 0) > 0;
  if (recorded) {
    appendHistory({
      action: "guard",
      event: "SessionStart",
      pluginEnabled: config.enabled,
      overlayActive: state.overlayActive === true,
      result: result?.skipped ? `skip-${result.reason}` : "restored",
      restoredPlugins: result?.restoredPlugins || 0,
      restoredFields,
      conflicts,
      errors,
      recoveredBackupEntries: result?.recoveredBackupEntries || 0,
      elapsedMs: Date.now() - startedAt,
    });
  }
  logLine(
    `guard SessionStart: ${
      result?.skipped ? `skip-${result.reason}` : "done"
    } restored=${restoredFields} conflicts=${conflicts} errors=${errors}`,
  );
  return result;
}

export async function guardMain() {
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
  try {
    const parsed = input.trim() ? JSON.parse(input) : {};
    await runGuardSessionStart(parsed);
  } catch (error) {
    logLine(`guard SessionStart 失败：${error.stack || error.message}`);
  }
}
