import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  DATA_DIR,
  ensureDirs,
  getSettings,
  nowIso,
  stringValue,
  writeJsonAtomic,
} from "./paths.mjs";
import { appendHistory } from "./lifecycle.mjs";

const LEGACY_TASK_NAME = "CodexPluginZhNativeSync";
const LEGACY_SETTING_KEYS = [
  "runtimeSource",
  "runtimeTarget",
  "runtimeVersion",
  "runtimeSyncedAt",
  "taskName",
  "taskSchemaVersion",
  "taskInstalledAt",
  "taskAction",
  "taskScript",
];

function removeLegacyDirectory(target) {
  if (!fs.existsSync(target)) return false;
  let dataRoot;
  let resolved;
  try {
    dataRoot = fs.realpathSync(DATA_DIR);
    resolved = fs.realpathSync(target);
  } catch {
    return false;
  }
  if (
    path.dirname(resolved).toLowerCase() !== dataRoot.toLowerCase() ||
    path.basename(resolved).toLowerCase() !== "tool"
  ) {
    return false;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  return true;
}

function removeLegacyFile(target) {
  if (!fs.existsSync(target)) return false;
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== path.resolve(DATA_DIR) || path.basename(resolved) !== "task.xml") {
    return false;
  }
  fs.rmSync(resolved, { force: true });
  return true;
}

function removeLegacyTask(removeTask) {
  if (!removeTask || process.platform !== "win32") {
    return { found: false, removed: false, error: null };
  }
  const query = spawnSync("schtasks.exe", ["/Query", "/TN", LEGACY_TASK_NAME], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  if (query.status !== 0) {
    const detail = stringValue(query.stderr || query.stdout).trim();
    const accessDenied = /access is denied|access denied|拒绝访问/i.test(detail);
    return {
      found: false,
      removed: false,
      error: accessDenied ? detail.slice(-1200) : null,
    };
  }
  spawnSync("schtasks.exe", ["/End", "/TN", LEGACY_TASK_NAME], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  const deletion = spawnSync("schtasks.exe", ["/Delete", "/TN", LEGACY_TASK_NAME, "/F"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  return {
    found: true,
    removed: deletion.status === 0,
    error:
      deletion.status === 0
        ? null
        : stringValue(deletion.stderr || deletion.stdout).trim().slice(-1200) ||
          `schtasks exited ${deletion.status}`,
  };
}

export function cleanupLegacyResidue({
  removeTask = true,
  removeTaskImpl = removeLegacyTask,
} = {}) {
  ensureDirs();
  const settings = getSettings();
  const legacySettings = LEGACY_SETTING_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(settings, key),
  );
  const toolDir = path.join(DATA_DIR, "tool");
  const taskXml = path.join(DATA_DIR, "task.xml");
  const hasToolDir = fs.existsSync(toolDir);
  const hasTaskXml = fs.existsSync(taskXml);
  const taskRequested =
    legacySettings.includes("taskName") ||
    legacySettings.includes("taskAction") ||
    hasTaskXml;

  if (!legacySettings.length && !hasToolDir && !hasTaskXml) {
    return {
      skipped: true,
      retryable: false,
      reason: "no-legacy-residue",
      removedTask: false,
      removedTool: false,
      removedTaskXml: false,
      removedSettings: [],
      errors: [],
    };
  }

  const errors = [];
  const task = removeTaskImpl(removeTask && taskRequested);
  if (task.error) {
    errors.push({ stage: "task", message: task.error });
    const result = {
      skipped: false,
      retryable: true,
      reason: "legacy-task-removal-failed",
      removedTask: false,
      removedTool: false,
      removedTaskXml: false,
      removedSettings: [],
      errors,
    };
    appendHistory({ action: "migration-cleanup", ...result });
    return result;
  }
  const removedTool = removeLegacyDirectory(toolDir);
  const removedTaskXml = removeLegacyFile(taskXml);

  if (legacySettings.length) {
    const next = { ...settings };
    for (const key of legacySettings) delete next[key];
    next.schemaVersion = 1;
    next.updatedAt = nowIso();
    writeJsonAtomic(path.join(DATA_DIR, "settings.json"), next);
  }

  const result = {
    skipped: false,
    retryable: false,
    reason: null,
    removedTask: task.removed,
    removedTool,
    removedTaskXml,
    removedSettings: legacySettings,
    errors,
  };
  appendHistory({ action: "migration-cleanup", ...result });
  return result;
}
