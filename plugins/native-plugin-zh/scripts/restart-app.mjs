// Standalone restart helper for the Codex desktop app.
//
// This file is copied to <data dir>\bin and launched by WMI
// (Win32_Process.Create), so it survives the death of the Codex process tree.
// It deliberately uses only Node built-ins: the plugin's lib directory may be
// replaced or removed while the helper is running.
//
// Flow: wait -> find matching ChatGPT.exe processes -> close gracefully ->
// force-kill leftovers -> relaunch the original executable.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    delaySeconds: 2,
    processName: "ChatGPT",
    pathPattern: "",
    exePath: "",
    exeArgs: [],
    logPath: "",
    dataDir: path.resolve(SCRIPT_DIR, ".."),
    testOnly: false,
    killWaitMs: 8000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      return argv[index] ?? "";
    };
    switch (arg) {
      case "--delay":
        options.delaySeconds = Number(value()) || 0;
        break;
      case "--process-name":
        options.processName = value() || "ChatGPT";
        break;
      case "--path-pattern":
        options.pathPattern = value();
        break;
      case "--exe-path":
        options.exePath = value();
        break;
      case "--exe-arg":
        options.exeArgs.push(value());
        break;
      case "--log-path":
        options.logPath = value();
        break;
      case "--data-dir":
        options.dataDir = value() || options.dataDir;
        break;
      case "--kill-wait-ms":
        options.killWaitMs = Math.max(0, Number(value()) || 0);
        break;
      case "--test-only":
        options.testOnly = true;
        break;
      default:
        break;
    }
  }
  if (!options.logPath) options.logPath = path.join(options.dataDir, "restart-app.log");
  return options;
}

const options = parseArgs(process.argv.slice(2));
const IMAGE_NAME = options.processName.toLowerCase().endsWith(".exe")
  ? options.processName
  : `${options.processName}.exe`;

function emit(line) {
  try {
    process.stdout.write(`${line}\n`);
  } catch {}
}

function log(message) {
  const line = `[${new Date().toISOString()}] restart-app: ${message}`;
  emit(line);
  try {
    fs.mkdirSync(path.dirname(options.logPath), { recursive: true });
    fs.appendFileSync(options.logPath, `${line}\n`, "utf8");
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function listProcesses() {
  const result = spawnSync(
    "tasklist.exe",
    ["/FI", `IMAGENAME eq ${IMAGE_NAME}`, "/FO", "CSV", "/NH"],
    { encoding: "utf8", windowsHide: true, timeout: 10000 },
  );
  if (result.error || result.status !== 0) return [];
  const seen = new Set();
  const processes = [];
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    if (!line.toLowerCase().includes(IMAGE_NAME.toLowerCase())) continue;
    const fields = parseCsvLine(line);
    const pid = Number(fields[1]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || seen.has(pid)) continue;
    seen.add(pid);
    processes.push({ pid, image: fields[0] });
  }
  return processes;
}

function globToRegExp(pattern) {
  const normalized = pattern.replace(/\//g, "\\");
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

// Best-effort path lookup. ExecutionPolicy is intentionally omitted: WMI-created
// processes are denied when PowerShell is started with -ExecutionPolicy.
function queryProcessPaths(pids) {
  if (!pids.length) return new Map();
  const command = `$ids = @(${pids.join(",")}); Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.Path)" }`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true, timeout: 10000 },
  );
  if (result.error || result.status !== 0) {
    log(`path query failed (status=${result.status ?? "n/a"}); falling back to image name`);
    return null;
  }
  const paths = new Map();
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const separator = line.indexOf("|");
    if (separator <= 0) continue;
    const pid = Number(line.slice(0, separator));
    const fileName = line.slice(separator + 1).trim();
    if (Number.isInteger(pid) && fileName) paths.set(pid, fileName);
  }
  return paths;
}

function normalizeFsPath(value) {
  let result = String(value || "").trim().replace(/^"(.*)"$/, "$1");
  if (result.startsWith("\\\\?\\")) result = result.slice(4);
  if (result.startsWith("\\??\\")) result = result.slice(4);
  return result;
}

function findWindowsAppsExe() {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const windowsApps = path.join(programFiles, "WindowsApps");
  try {
    return (
      fs
        .readdirSync(windowsApps, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("OpenAI.Codex_"))
        .map((entry) => {
          const root = path.join(windowsApps, entry.name);
          const executable = path.join(root, "app", IMAGE_NAME);
          try {
            return fs.existsSync(executable)
              ? { executable, modified: fs.statSync(root).mtimeMs }
              : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((left, right) => right.modified - left.modified)[0]?.executable || null
    );
  } catch {
    return null;
  }
}

function resolveExePath(paths, targets) {
  if (options.exePath) {
    const explicit = normalizeFsPath(options.exePath);
    if (fs.existsSync(explicit)) return explicit;
    log(`explicit exe path not found: ${explicit}`);
  }
  if (paths) {
    for (const target of targets) {
      const runningPath = paths.get(target.pid);
      if (runningPath && fs.existsSync(runningPath)) return runningPath;
    }
  }
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(options.dataDir, "settings.json"), "utf8"),
    );
    const codexBin = normalizeFsPath(settings.codexBin);
    if (codexBin) {
      const candidate = path.resolve(path.dirname(codexBin), "..", "..", IMAGE_NAME);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return findWindowsAppsExe();
}

function packageFamilyName(exePath) {
  const packageRoot = path.basename(path.dirname(path.dirname(exePath)));
  const match = packageRoot.match(/^(.+?)_[^_]+_[^_]+__(.+)$/);
  return match ? `${match[1]}_${match[2]}` : null;
}

function explorerLaunch(args) {
  try {
    spawn("explorer.exe", args, { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

function taskkill(args) {
  const result = spawnSync("taskkill.exe", args, {
    windowsHide: true,
    stdio: "ignore",
    timeout: 15000,
  });
  return result.status === 0;
}

async function closeTargets(targets) {
  if (!targets.length) return;
  for (const target of targets) taskkill(["/PID", String(target.pid)]);

  const deadline = Date.now() + options.killWaitMs;
  while (Date.now() < deadline) {
    const remaining = listProcesses().some((item) =>
      targets.some((target) => target.pid === item.pid),
    );
    if (!remaining) break;
    await sleep(300);
  }

  const remaining = listProcesses().filter((item) =>
    targets.some((target) => target.pid === item.pid),
  );
  if (remaining.length) {
    log(`force-closing ${remaining.length} process(es)`);
    for (const target of remaining) taskkill(["/F", "/PID", String(target.pid)]);
    await sleep(600);
  }

  if (listProcesses().length) {
    log("force-closing remaining processes by image name");
    taskkill(["/F", "/IM", IMAGE_NAME]);
    await sleep(600);
  }
}

async function main() {
  log(
    `starting delay=${options.delaySeconds}s process=${options.processName}` +
      (options.pathPattern ? ` pattern=${options.pathPattern}` : "") +
      (options.testOnly ? " test-only" : ""),
  );
  if (options.delaySeconds > 0) await sleep(options.delaySeconds * 1000);

  let targets = listProcesses();
  if (!targets.length) {
    log("no matching process");
    return 0;
  }

  // 路径查询既用于可选的 pathPattern 过滤，也用于在 settings 缺失时
  // 从运行中的进程直接取得可执行文件路径（WindowsApps 目录不可枚举）。
  const paths = queryProcessPaths(targets.map((item) => item.pid));
  if (options.pathPattern) {
    if (paths) {
      const matcher = globToRegExp(options.pathPattern);
      const matched = targets.filter((item) => {
        const fileName = paths.get(item.pid);
        return fileName ? matcher.test(fileName) : false;
      });
      if (!matched.length && paths.size) {
        log("no matching process after path filter");
        return 0;
      }
      if (matched.length) targets = matched;
    }
  }

  const exePath = resolveExePath(paths, targets);
  if (!exePath) {
    log("cannot resolve the Codex executable path");
    return 1;
  }
  log(`found ${targets.length} process(es); exe=${exePath}`);
  if (paths) {
    const first = targets.map((item) => paths.get(item.pid)).find(Boolean);
    if (first) log(`first running path=${first}`);
  }

  if (options.testOnly) return 0;

  await closeTargets(targets);
  if (listProcesses().length) {
    log("target process is still running; aborting relaunch");
    return 1;
  }
  // 给单实例互斥量和文件句柄一点释放时间，避免新进程刚启动就退出。
  await sleep(800);

  try {
    const child = spawn(exePath, options.exeArgs, {
      cwd: path.dirname(exePath),
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => log(`relaunch failed: ${error.message}`));
    child.unref();
    log(`relaunched pid=${child.pid}`);
  } catch (error) {
    log(`relaunch threw: ${error.message}`);
    spawn("explorer.exe", [exePath], { detached: true, stdio: "ignore" }).unref();
    log("explorer fallback issued");
    return 0;
  }

  await sleep(4000);
  if (!listProcesses().length) {
    log("relaunch not observed; trying explorer");
    explorerLaunch([exePath]);
    await sleep(2500);
    if (!listProcesses().length) {
      const family = packageFamilyName(exePath);
      if (family) {
        explorerLaunch([`shell:AppsFolder\\${family}!App`]);
        log(`relaunch still not observed; tried shell:AppsFolder\\${family}!App`);
      }
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    log(`failed: ${error.stack || error.message}`);
    process.exit(1);
  });
