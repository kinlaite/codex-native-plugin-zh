import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const APP_VERSION = "1.6.2";
export const APP_ID = "native-plugin-zh";
export const LOCALE = "zh-CN";
export const PLUGIN_ID = "native-plugin-zh@native-plugin-zh-local";
export const FIELDS = ["displayName", "shortDescription", "longDescription"];
export const TRANSLATION_BACKOFF_MS = 15 * 60 * 1000;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = path.resolve(MODULE_DIR, "..");
export const CODEX_HOME = path.resolve(
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
);
export const DATA_DIR = path.resolve(
  process.env.CODEX_PLUGIN_ZH_DATA_DIR ||
    path.join(CODEX_HOME, "plugin-i18n-native"),
);
export const STATE_FILE = path.join(DATA_DIR, "state.json");
export const PACK_FILE = path.join(DATA_DIR, "translations.zh-CN.json");
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
export const CATALOG_FILE = path.join(DATA_DIR, "catalog-state.json");
export const CONFIG_FILE = path.join(CODEX_HOME, "config.toml");
export const HISTORY_FILE = path.join(DATA_DIR, "history.jsonl");
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
export const LOG_FILE = path.join(DATA_DIR, "sync.log");
export const LOCK_FILE = path.join(DATA_DIR, "sync.lock");
export const SCHEMA_FILE = path.join(DATA_DIR, "translation.schema.json");
export const SEED_FILE = path.join(PLUGIN_DIR, "translations", `${LOCALE}.seed.json`);
export const MAP_FILE = path.join(PLUGIN_DIR, "translations", `${LOCALE}.map.json`);

export function nowIso() {
  return new Date().toISOString();
}

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stringValue(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    const text = stringValue(value);
    if (text.trim()) return text;
  }
  return "";
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function hasHan(value) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(stringValue(value));
}

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  ensureDirs();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temp, file);
  } catch {
    fs.copyFileSync(temp, file);
    fs.unlinkSync(temp);
  }
}

export function writeTextAtomic(file, value, encoding = "utf8") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, value, encoding);
  try {
    fs.renameSync(temp, file);
  } catch {
    fs.copyFileSync(temp, file);
    fs.unlinkSync(temp);
  }
}

export function getSettings() {
  const settings = readJson(SETTINGS_FILE, null);
  return isObject(settings) ? settings : {};
}

export function updateSettings(patch) {
  const settings = { ...getSettings(), ...patch };
  settings.schemaVersion = 1;
  settings.updatedAt = nowIso();
  writeJsonAtomic(SETTINGS_FILE, settings);
  return settings;
}

export function logLine(message) {
  try {
    ensureDirs();
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      const oldFile = `${LOG_FILE}.1`;
      try {
        fs.unlinkSync(oldFile);
      } catch {}
      fs.renameSync(LOG_FILE, oldFile);
    }
    fs.appendFileSync(LOG_FILE, `[${nowIso()}] ${message}\n`, "utf8");
  } catch {}
}

export function normalizeFsPath(value) {
  let result = stringValue(value).trim().replace(/^"(.*)"$/, "$1");
  if (result.startsWith("\\\\?\\")) result = result.slice(4);
  if (result.startsWith("\\??\\")) result = result.slice(4);
  return result;
}

export function findOnPath(fileNames) {
  const directories = stringValue(process.env.PATH)
    .split(path.delimiter)
    .map((item) => item.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  for (const directory of directories) {
    for (const fileName of fileNames) {
      const candidate = path.join(directory, fileName);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

function findNewestWindowsAppsCodexExe() {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const windowsApps = path.join(programFiles, "WindowsApps");
  try {
    return (
      fs
        .readdirSync(windowsApps, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("OpenAI.Codex_"))
        .map((entry) => {
          const root = path.join(windowsApps, entry.name);
          const executable = path.join(root, "app", "resources", "codex.exe");
          try {
            return fs.existsSync(executable)
              ? { executable, modified: fs.statSync(root).mtimeMs }
              : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.modified - a.modified)[0]?.executable || null
    );
  } catch {
    return null;
  }
}

function findAppxCodexExe() {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation",
    ],
    { windowsHide: true, encoding: "utf8", timeout: 10000 },
  );
  const installLocation = normalizeFsPath(result.stdout).trim();
  if (!installLocation) return null;
  const executable = path.join(installLocation, "app", "resources", "codex.exe");
  return fs.existsSync(executable) ? executable : null;
}

export function resolveCodexCommand({ save = false } = {}) {
  const envCommand = normalizeFsPath(process.env.CODEX_BIN);
  if (envCommand && fs.existsSync(envCommand)) return envCommand;

  const settings = getSettings();
  const savedCommand = normalizeFsPath(settings.codexBin);
  const resolved =
    findNewestWindowsAppsCodexExe() ||
    (savedCommand && fs.existsSync(savedCommand) ? savedCommand : null) ||
    findOnPath(["codex.exe"]) ||
    findAppxCodexExe() ||
    findOnPath(["codex.cmd"]) ||
    "codex";

  if (save && resolved !== "codex" && normalizeFsPath(resolved) !== savedCommand) {
    updateSettings({
      codexBin: resolved,
      nodeBin: process.execPath,
    });
  }
  return resolved;
}

function lockEndpoint() {
  const identity = path.resolve(DATA_DIR);
  const normalized = process.platform === "win32" ? identity.toLowerCase() : identity;
  const suffix = sha256(normalized).slice(0, 32);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\codex-native-plugin-zh-${suffix}`
    : path.join(DATA_DIR, `.sync-${suffix}.sock`);
}

function openLockEndpoint() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    const onError = (error) => {
      server.removeListener("listening", onListening);
      try {
        server.close();
      } catch {}
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      server.on("error", (error) => {
        logLine(`同步锁监听错误：${error.message}`);
      });
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(lockEndpoint());
  });
}

function closeLockEndpoint(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

export async function withLock(fn, { waitMs = 0, retryMs = 60 } = {}) {
  ensureDirs();
  const deadline = Date.now() + Math.max(0, waitMs);
  let endpoint = await openLockEndpoint();
  while (!endpoint && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    endpoint = await openLockEndpoint();
  }
  if (!endpoint) {
    logLine("跳过：系统同步锁已被另一个进程持有");
    return { skipped: true, reason: "locked" };
  }

  const token = crypto.randomUUID();
  const startedAt = nowIso();
  try {
    writeJsonAtomic(LOCK_FILE, {
      pid: process.pid,
      token,
      startedAt,
      mechanism: "system-endpoint",
    });
  } catch (error) {
    logLine(`写入同步锁诊断信息失败：${error.message}`);
  }

  try {
    return await fn();
  } finally {
    try {
      const current = readJson(LOCK_FILE, null);
      if (current?.token === token) fs.unlinkSync(LOCK_FILE);
    } catch {}
    await closeLockEndpoint(endpoint);
  }
}
