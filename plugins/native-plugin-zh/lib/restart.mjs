// 应用自动重启。
//
// 用户切换插件开关后，把清单写对只是前一半；界面要看到新语言还必须让
// Codex 重新读取插件目录。这里负责“自动重启”这后一半：
//   1. requestAppRestart  —— 纯决策：尊重 autoRestartApp 设置；按开关状态
//      签名做 45s 冷却去重（插件内监听器与用户级恢复服务器可能同时发现
//      同一次切换），不同状态的反向切换不受冷却影响；
//   2. launchRestartHelper —— 执行：通过 WMI (Win32_Process.Create) 派生
//      restart-app.mjs。WmiPrvSE（系统服务）创建的进程在调用方进程树和
//      job 对象之外，因此能在 ChatGPT.exe 被关闭后继续完成“关闭 -> 重新
//      拉起”的流程。直接 detached 派生无法保证这一点。
//      WMI 启动时设置 DETACHED_PROCESS (CreateFlags=8)，避免为 Node 控制台
//      程序分配 conhost.exe，从而不显示任何命令行黑色窗口。
//
// 助手用 Node 而不是 PowerShell：实测 WMI 派生 PowerShell 时，一旦带上
// -ExecutionPolicy 就会在引擎启动前以“拒绝访问”(exit 5) 退出；Node 不受
// 执行策略影响，且插件本身就依赖 Node。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  DATA_DIR,
  getSettings,
  logLine,
  normalizeFsPath,
  nowIso,
  readJson,
  writeJsonAtomic,
} from "./paths.mjs";
import { appendHistory } from "./lifecycle.mjs";

const MARKER_FILE = path.join(DATA_DIR, "restart-request.json");
const COOLDOWN_MS = 45_000;
const DEFAULT_PATH_PATTERN = "*\\OpenAI.Codex_*\\app\\ChatGPT.exe";

export function requestAppRestart({ reason = "toggle", force = false, signature } = {}) {
  const settings = getSettings();
  if (settings.autoRestartApp === false) {
    return { allowed: false, reason: "disabled-by-settings" };
  }
  const marker = readJson(MARKER_FILE, null);
  const lastAt = Date.parse(marker?.at || 0);
  // 没有签名时（旧标记/手动演练）退回纯时间冷却；有签名时只对同一开关
  // 状态的重复触发去重，避免“启用后马上关闭”被第一次重启的冷却挡住。
  const sameSignature = signature ? marker?.signature === signature : true;
  if (!force && sameSignature && Number.isFinite(lastAt) && Date.now() - lastAt < COOLDOWN_MS) {
    return { allowed: false, reason: "cooldown", lastRequestAt: marker.at };
  }
  writeJsonAtomic(MARKER_FILE, {
    at: nowIso(),
    reason,
    pid: process.pid,
    ...(signature ? { signature } : {}),
  });
  return { allowed: true, reason };
}

export function launchRestartHelper({
  reason = "toggle",
  delaySeconds = 2,
  processName,
  pathPattern,
  exePath,
  exeArgs,
  killWaitMs,
} = {}) {
  const helper = path.join(DATA_DIR, "bin", "restart-app.mjs");
  if (!fs.existsSync(helper)) {
    logLine(`restart: 辅助脚本缺失（${helper}）`);
    return { launched: false, reason: "helper-missing" };
  }
  const nodeBin = resolveNodeBin();
  const logPath = path.join(DATA_DIR, "restart-app.log");
  const args = [
    "--delay",
    String(delaySeconds),
    "--log-path",
    logPath,
    "--data-dir",
    DATA_DIR,
  ];
  if (processName) args.push("--process-name", processName);
  // 默认只匹配 Codex 自己的 ChatGPT.exe；路径查询失败时助手会退回镜像名。
  const pattern = pathPattern === undefined ? DEFAULT_PATH_PATTERN : pathPattern;
  if (pattern) args.push("--path-pattern", pattern);
  if (exePath) args.push("--exe-path", exePath);
  if (Array.isArray(exeArgs)) {
    for (const value of exeArgs) args.push("--exe-arg", value);
  }
  if (killWaitMs !== undefined) args.push("--kill-wait-ms", String(killWaitMs));

  const inner = [nodeBin, helper, ...args].map(quoteWindowsArg).join(" ");
  const escaped = inner.replace(/'/g, "''");
  const command =
    `$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance(); ` +
    `$startup.CreateFlags = [uint32]8; ` +
    `$created = ([wmiclass]'Win32_Process').Create('${escaped}', $null, $startup); ` +
    "$created | Select-Object ProcessId,ReturnValue | ConvertTo-Json -Compress";
  // 外层 PowerShell 是当前进程的直接子进程，可以正常使用 -ExecutionPolicy；
  // WMI 只负责创建真正的 helper。用 spawnSync 拿到 ReturnValue 便于诊断。
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8", timeout: 15000, windowsHide: true },
  );
  let created = null;
  try {
    created = JSON.parse(String(result.stdout || "").trim());
  } catch {}
  if (result.error || result.status !== 0 || !created || created.ReturnValue !== 0) {
    logLine(
      `restart: WMI 派生失败 status=${result.status ?? "n/a"} ` +
        `stdout=${String(result.stdout || "").trim()} stderr=${String(result.stderr || "").trim()}`,
    );
    // 兜底：直接 detached。若 Codex 没有 kill-on-close job，它仍能完成重启。
    try {
      const fallback = spawn(nodeBin, [helper, ...args], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      fallback.unref();
      logLine(`restart: 已退化为直接派生辅助进程 pid=${fallback.pid} (${reason})`);
      appendHistory({ action: "restart", event: reason, delaySeconds, fallback: true });
      return { launched: true, pid: fallback.pid, fallback: true };
    } catch (error) {
      logLine(`restart: 兜底派生也失败：${error.message}`);
      return { launched: false, reason: "spawn-failed" };
    }
  }
  logLine(
    `restart: 已通过 WMI 派生重启辅助进程 pid=${created.ProcessId} (${reason})`,
  );
  appendHistory({
    action: "restart",
    event: reason,
    delaySeconds,
    helperPid: created.ProcessId,
  });
  return { launched: true, pid: created.ProcessId };
}

export function requestAndLaunchAppRestart(options = {}) {
  const decision = requestAppRestart(options);
  if (!decision.allowed) return decision;
  return { ...decision, ...launchRestartHelper(options) };
}

function resolveNodeBin() {
  const settings = getSettings();
  const candidates = [
    normalizeFsPath(settings.nodeBin),
    normalizeFsPath(process.execPath),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return "node.exe";
}

// Windows 命令行引用规则；只有包含空白或引号时才加引号。
function quoteWindowsArg(value) {
  const text = String(value);
  if (!/[\s"]/.test(text)) return text;
  let quoted = text.replace(/(\\*)"/g, '$1$1\\"');
  quoted = quoted.replace(/(\\+)$/, "$1$1");
  return `"${quoted}"`;
}
