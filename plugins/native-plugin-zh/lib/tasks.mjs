import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  APP_VERSION,
  CODEX_HOME,
  DATA_DIR,
  PACK_FILE,
  PLUGIN_DIR,
  SETTINGS_FILE,
  STATE_FILE,
  TASK_NAME,
  TASK_SCHEMA_VERSION,
  TASK_XML_FILE,
  TOOL_DIR,
  copyFileAtomic,
  ensureDirs,
  getSettings,
  logLine,
  nowIso,
  readJson,
  resolveCodexCommand,
  updateSettings,
  writeJsonAtomic,
  writeTextAtomic,
  xmlEscape,
} from "./paths.mjs";
import { loadState, packStats, loadPack, saveState } from "./storage.mjs";
import { status, syncWithTranslation } from "./sync.mjs";

const RUNTIME_FILES = [
  "server.mjs",
  "package.json",
  "lib/paths.mjs",
  "lib/storage.mjs",
  "lib/discovery.mjs",
  "lib/sync.mjs",
  "lib/tasks.mjs",
  "scripts/cli.mjs",
  "scripts/launch_mcp.cmd",
  "scripts/run-sync.ps1",
  "scripts/run-sync-hidden.vbs",
  "translations/zh-CN.seed.json",
  "translations/zh-CN.map.json",
  "README.md",
];

export function syncRuntimeToStable() {
  ensureDirs();
  const sourceRoot = path.resolve(PLUGIN_DIR);
  const targetRoot = path.resolve(TOOL_DIR);
  if (sourceRoot.toLowerCase() === targetRoot.toLowerCase()) {
    return {
      copied: 0,
      sourceRoot,
      targetRoot,
      skipped: true,
      version: APP_VERSION,
    };
  }

  const copied = [];
  for (const relative of RUNTIME_FILES) {
    const source = path.join(sourceRoot, relative);
    if (!fs.existsSync(source)) continue;
    const target = path.join(targetRoot, relative);
    copyFileAtomic(source, target);
    copied.push(relative);
  }
  writeJsonAtomic(path.join(targetRoot, "runtime.json"), {
    schemaVersion: 1,
    appVersion: APP_VERSION,
    sourceRoot,
    targetRoot,
    syncedAt: nowIso(),
    files: copied,
  });
  updateSettings({
    runtimeSource: sourceRoot,
    runtimeTarget: targetRoot,
    runtimeVersion: APP_VERSION,
    runtimeSyncedAt: nowIso(),
  });
  logLine(`运行时代码已同步到稳定目录：${targetRoot}（${copied.length} 个文件）`);
  return {
    copied: copied.length,
    sourceRoot,
    targetRoot,
    skipped: false,
    version: APP_VERSION,
  };
}

function currentUser() {
  const domain = process.env.USERDOMAIN || ".";
  const user = process.env.USERNAME || process.env.USER || "";
  return user ? `${domain}\\${user}` : user;
}

function localStartBoundary() {
  const date = new Date(Date.now() - 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function taskRuntimePaths() {
  return {
    powershellPath: path.join(
      process.env.WINDIR || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    scriptPath: path.join(TOOL_DIR, "scripts", "run-sync.ps1"),
  };
}

function buildTaskXml(powershellPath, scriptPath) {
  const workingDirectory = path.dirname(scriptPath);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Codex 原生插件界面中文化自动同步</Description>
    <URI>\\${xmlEscape(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(currentUser())}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${localStartBoundary()}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(currentUser())}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(powershellPath)}</Command>
      <Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${xmlEscape(scriptPath)}"</Arguments>
      <WorkingDirectory>${xmlEscape(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function getTaskStatus() {
  const { powershellPath: expectedPowerShell, scriptPath: expectedScript } = taskRuntimePaths();
  const expectedWorkingDirectory = path.dirname(expectedScript);
  const queryScript = `
$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop
$info = Get-ScheduledTaskInfo -TaskName '${TASK_NAME}' -ErrorAction Stop
$action = @($task.Actions)[0]
$logon = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })[0]
$time = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger' })[0]
[pscustomobject]@{
  state = [string]$task.State
  settingsEnabled = [bool]$task.Settings.Enabled
  logonEnabled = [bool]$logon.Enabled
  timeEnabled = [bool]$time.Enabled
  interval = [string]$time.Repetition.Interval
  triggerCount = [int]@($task.Triggers).Count
  execute = [string]$action.Execute
  arguments = [string]$action.Arguments
  workingDirectory = [string]$action.WorkingDirectory
  lastTaskResult = [int64]$info.LastTaskResult
  lastRunTime = if ($info.LastRunTime) { $info.LastRunTime.ToString('o') } else { $null }
} | ConvertTo-Json -Compress
`;
  const result = spawnSync(
    expectedPowerShell,
    ["-NoProfile", "-NonInteractive", "-Command", queryScript],
    { windowsHide: true, encoding: "utf8", timeout: 15000 },
  );
  if (result.status !== 0) {
    return {
      exists: false,
      ok: false,
      actionMatches: false,
      triggersOk: false,
      taskEnabled: false,
      taskName: TASK_NAME,
      expectedPowerShell,
      expectedScript,
      expectedWorkingDirectory,
      queryError: String(result.stderr || result.stdout || "").trim().slice(-1200),
    };
  }
  let data;
  try {
    data = JSON.parse(String(result.stdout || "").trim());
  } catch (error) {
    return {
      exists: false,
      ok: false,
      actionMatches: false,
      triggersOk: false,
      taskEnabled: false,
      taskName: TASK_NAME,
      expectedPowerShell,
      expectedScript,
      expectedWorkingDirectory,
      queryError: `无法解析任务状态：${error.message}`,
    };
  }
  const actionMatches =
    String(data.execute || "").toLowerCase() === expectedPowerShell.toLowerCase() &&
    String(data.arguments || "").toLowerCase().includes(expectedScript.toLowerCase()) &&
    String(data.workingDirectory || "").toLowerCase() ===
      expectedWorkingDirectory.toLowerCase();
  const triggersOk =
    data.logonEnabled === true &&
    data.timeEnabled === true &&
    String(data.interval || "").toUpperCase() === "PT5M";
  const taskEnabled = data.settingsEnabled === true && data.state !== "Disabled";
  return {
    ...data,
    exists: true,
    ok: actionMatches && triggersOk && taskEnabled,
    actionMatches,
    triggersOk,
    taskEnabled,
    taskName: TASK_NAME,
    expectedPowerShell,
    expectedScript,
    expectedWorkingDirectory,
  };
}

export function installAutoSync({ force = false } = {}) {
  if (process.platform !== "win32") throw new Error("自动同步任务仅支持 Windows");
  ensureDirs();
  syncRuntimeToStable();
  const { powershellPath, scriptPath } = taskRuntimePaths();
  if (!fs.existsSync(powershellPath)) {
    throw new Error(`Windows PowerShell 不存在：${powershellPath}`);
  }
  if (!fs.existsSync(scriptPath)) throw new Error(`稳定同步脚本不存在：${scriptPath}`);

  const current = getTaskStatus();
  const settings = getSettings();
  if (
    !force &&
    current.ok &&
    settings.taskSchemaVersion === TASK_SCHEMA_VERSION
  ) {
    return {
      installed: true,
      recreated: false,
      taskName: TASK_NAME,
      action: powershellPath,
      script: scriptPath,
    };
  }

  const xml = buildTaskXml(powershellPath, scriptPath);
  writeTextAtomic(TASK_XML_FILE, `\ufeff${xml}`, "utf16le");
  const result = spawnSync(
    "schtasks.exe",
    ["/Create", "/TN", TASK_NAME, "/XML", TASK_XML_FILE, "/F"],
    { windowsHide: true, encoding: "utf8", timeout: 30000 },
  );
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`创建计划任务失败：${detail.slice(-2000)}`);
  }

  updateSettings({
    taskName: TASK_NAME,
    taskSchemaVersion: TASK_SCHEMA_VERSION,
    taskInstalledAt: nowIso(),
    taskAction: `${powershellPath} -File ${scriptPath}`,
    autoTranslate: settings.autoTranslate !== false,
  });
  logLine(`计划任务已安装：${TASK_NAME} -> ${scriptPath}`);
  return {
    installed: true,
    recreated: true,
    taskName: TASK_NAME,
    action: powershellPath,
    script: scriptPath,
    output: String(result.stdout || "").trim(),
  };
}

export function uninstallAutoSync() {
  if (process.platform !== "win32") throw new Error("自动同步任务仅支持 Windows");
  const result = spawnSync(
    "schtasks.exe",
    ["/Delete", "/TN", TASK_NAME, "/F"],
    { windowsHide: true, encoding: "utf8", timeout: 15000 },
  );
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    if (!/cannot find|找不到|不存在/i.test(detail)) {
      throw new Error(`删除计划任务失败：${detail.slice(-1200)}`);
    }
  }
  updateSettings({ taskUninstalledAt: nowIso() });
  logLine(`计划任务已删除：${TASK_NAME}`);
  return { removed: true, taskName: TASK_NAME };
}

export async function bootstrap({ syncCached = true } = {}) {
  if (process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP === "1") {
    return { skipped: true, reason: "disabled-by-env" };
  }
  ensureDirs();
  const runtime = syncRuntimeToStable();
  let task = null;
  let taskError = null;
  if (process.env.CODEX_PLUGIN_ZH_NO_TASK !== "1") {
    try {
      task = installAutoSync();
    } catch (error) {
      taskError = error.message;
      logLine(`自动同步任务安装失败：${error.message}`);
    }
  }

  const state = loadState();
  if (!fs.existsSync(STATE_FILE)) saveState(state);
  let syncResult = null;
  if (syncCached && state.enabled) {
    syncResult = await syncWithTranslation({ autoTranslate: false, quiet: true });
  }
  return { runtime, task, taskError, sync: syncResult };
}

export async function diagnose({ json = false, quiet = false } = {}) {
  const current = getTaskStatus();
  const setting = getSettings();
  const state = loadState();
  const pack = loadPack();
  const syncStatus = await status({ json: false, quiet: true });
  const codexBin = resolveCodexCommand();
  const payload = {
    appVersion: APP_VERSION,
    dataDir: DATA_DIR,
    toolDir: TOOL_DIR,
    pluginDir: PLUGIN_DIR,
    codexHome: CODEX_HOME,
    codexBin,
    codexBinExists: codexBin !== "codex" && fs.existsSync(codexBin),
    nodeBin: setting.nodeBin || process.execPath,
    nodeBinExists: fs.existsSync(setting.nodeBin || process.execPath),
    runtimeVersion: setting.runtimeVersion || null,
    runtimeSyncedAt: setting.runtimeSyncedAt || null,
    enabled: state.enabled,
    stateFile: STATE_FILE,
    packFile: PACK_FILE,
    packStats: packStats(pack),
    task: {
      ...current,
      schemaVersion: setting.taskSchemaVersion || null,
      installedAt: setting.taskInstalledAt || null,
    },
    sync: {
      localPlugins: syncStatus.localPlugins,
      installedPlugins: syncStatus.installedPlugins,
      remoteSkipped: syncStatus.remoteSkipped,
      pending: syncStatus.pending.length,
      plannedFields: syncStatus.plannedFields,
      alreadyChineseFields: syncStatus.alreadyChineseFields,
      discoverySource: syncStatus.discoverySource,
      errors: syncStatus.errors,
      lastSyncAt: syncStatus.lastSyncAt,
    },
    lastTranslationFailureAt: readJson(SETTINGS_FILE, null)?.lastTranslationFailureAt || null,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (!quiet) {
    console.log(`插件版本：${payload.appVersion}`);
    console.log(`稳定运行目录：${payload.toolDir}`);
    console.log(`Codex：${payload.codexBin}（${payload.codexBinExists ? "存在" : "需重新定位"}）`);
    console.log(`Node：${payload.nodeBin}（${payload.nodeBinExists ? "存在" : "缺失"}）`);
    console.log(`自动同步任务：${payload.task.exists ? "已安装" : "缺失"}`);
    if (payload.task.exists) {
      console.log(`任务指向稳定目录：${payload.task.actionMatches ? "是" : "否"}`);
    }
    console.log(`自动中文化：${payload.enabled ? "已启用" : "已暂停"}`);
    console.log(
      `插件与字段：${payload.sync.localPlugins} / ${payload.sync.alreadyChineseFields + payload.sync.pending.length}`,
    );
    console.log(`待翻译：${payload.sync.pending}`);
    console.log(`发现方式：${payload.sync.discoverySource || "未知"}`);
  }
  return payload;
}
