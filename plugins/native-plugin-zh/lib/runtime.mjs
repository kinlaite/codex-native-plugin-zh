import { appendHistory, readPluginConfigState } from "./lifecycle.mjs";
import { restoreOriginals, syncWithTranslation } from "./sync.mjs";
import { loadStateInfo, saveState } from "./storage.mjs";

export async function startLifecycle({
  reason = "runtime-start",
  trigger = "mcp",
  lockWaitMs = 5000,
  quiet = true,
} = {}) {
  const config = readPluginConfigState();
  const { state, persisted, hadLifecycleMarker } = loadStateInfo();

  if (!config.enabled) {
    const result = await restoreOriginals({
      preserveIntent: true,
      onlyIfOverlayActive: false,
      lastPluginConfigEnabled: false,
      requirePluginDisabled: true,
      reason: config.found ? "plugin-disabled" : "plugin-config-missing",
      trigger,
      lockWaitMs,
      quiet,
    });
    appendHistory({
      action: "lifecycle",
      event: "start",
      trigger,
      result: result?.skipped ? "skip-locked" : "restore-disabled",
      restoredFields: result?.restoredFields || 0,
    });
    return result;
  }

  const pluginSwitchTurnedOn = hadLifecycleMarker
    ? state.lastPluginConfigEnabled === false
    : !persisted || state.enabled !== false;
  if (!state.enabled && !pluginSwitchTurnedOn) {
    if (!hadLifecycleMarker) {
      state.lastPluginConfigEnabled = config.enabled;
      saveState(state);
    }
    appendHistory({
      action: "lifecycle",
      event: "start",
      trigger,
      result: "skip-manually-paused",
    });
    return { action: "skip", reason: "intent-disabled" };
  }

  const result = await syncWithTranslation({
    enable: true,
    lastPluginConfigEnabled: true,
    autoTranslate: false,
    allowAppServer: false,
    allowCli: false,
    quiet,
    scope: "all-local",
    requirePluginEnabled: true,
    lockWaitMs,
  });

  appendHistory({
    action: "lifecycle",
    event: "start",
    trigger,
    result: result?.skipped ? "skip-locked" : "applied",
    changedPlugins: result?.changedPlugins || 0,
    appliedFields: result?.appliedFields || 0,
  });
  return result;
}

export async function endLifecycle({
  trigger = "mcp",
  lockWaitMs = 4000,
  quiet = true,
} = {}) {
  const config = readPluginConfigState();
  const result = await restoreOriginals({
    preserveIntent: true,
    onlyIfOverlayActive: false,
    lastPluginConfigEnabled: false,
    requirePluginDisabled: true,
    reason: config.found ? "plugin-disabled" : "plugin-config-missing",
    trigger,
    lockWaitMs,
    quiet,
  });
  const kept =
    result?.skipped && result.reason === "plugin-enabled-before-lock";
  appendHistory({
    action: "lifecycle",
    event: "end",
    trigger,
    result: kept ? "keep-plugin-enabled" : result?.skipped ? "skip-locked" : "restored",
    restoredPlugins: result?.restoredPlugins || 0,
    restoredFields: result?.restoredFields || 0,
  });
  return kept
    ? { action: "keep", reason: "plugin-still-enabled" }
    : result;
}
