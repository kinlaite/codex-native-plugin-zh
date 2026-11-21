import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-restart-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(codexHome, "plugin-i18n-native");
fs.mkdirSync(dataDir, { recursive: true });
process.env.CODEX_HOME = codexHome;
process.env.CODEX_PLUGIN_ZH_DATA_DIR = dataDir;
process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP = "1";
process.env.USERPROFILE = root;
process.env.HOME = root;

const { launchRestartHelper, requestAppRestart } = await import("../lib/restart.mjs");
const { syncRestoreServerBin } = await import("../lib/registration.mjs");
const { getSettings, updateSettings } = await import("../lib/paths.mjs");

test("syncs the Node restart helper into the data dir", () => {
  assert.equal(syncRestoreServerBin(), true);
  const helper = fs.readFileSync(path.join(dataDir, "bin", "restart-app.mjs"), "utf8");
  assert.match(helper, /--process-name/);
  assert.match(helper, /Win32_Process|taskkill/);
  const restart = fs.readFileSync(path.resolve("lib", "restart.mjs"), "utf8");
  assert.match(
    restart,
    /Win32_ProcessStartup[\s\S]*CreateFlags = \[uint32\]8/,
    "WMI 助手必须使用 DETACHED_PROCESS，避免弹出命令行窗口",
  );
  assert.match(
    restart,
    /detached: true,[\s\S]*windowsHide: true/,
    "直接派生兜底也必须隐藏窗口",
  );
  assert.equal(
    fs.existsSync(path.join(dataDir, "bin", "restart-app.ps1")),
    false,
    "旧的 PowerShell 助手应被清理",
  );
});

test("restart request honors settings switch and cooldown", () => {
  // 第一次请求放行并写入冷却标记
  const first = requestAppRestart({ reason: "test-first" });
  assert.equal(first.allowed, true);

  // 冷却期内被去重
  const second = requestAppRestart({ reason: "test-second" });
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "cooldown");

  // force 绕过冷却
  const forced = requestAppRestart({ reason: "test-force", force: true });
  assert.equal(forced.allowed, true);

  // 同一开关状态的重复触发被去重；反向状态切换不受冷却影响
  assert.equal(
    requestAppRestart({ reason: "sig-a", signature: "enabled=true", force: true }).allowed,
    true,
  );
  assert.equal(
    requestAppRestart({ reason: "sig-a-again", signature: "enabled=true" }).reason,
    "cooldown",
  );
  assert.equal(
    requestAppRestart({ reason: "sig-b", signature: "enabled=false" }).allowed,
    true,
  );

  // 关闭设置后不再放行
  updateSettings({ autoRestartApp: false });
  assert.equal(getSettings().autoRestartApp, false);
  const disabled = requestAppRestart({ reason: "test-disabled", force: true });
  assert.equal(disabled.allowed, false);
  assert.equal(disabled.reason, "disabled-by-settings");
  updateSettings({ autoRestartApp: null });
});

test("restart helper discovers the running Codex desktop app in TestOnly mode", () => {
  const helper = path.join(dataDir, "bin", "restart-app.mjs");
  const result = spawnSync(
    process.execPath,
    [helper, "--delay", "0", "--test-only"],
    { encoding: "utf8", timeout: 30000, windowsHide: true },
  );
  assert.equal(result.status, 0, `exit=${result.status} stderr=${result.stderr}`);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /restart-app:/);
  // 机器上 Codex 桌面应用（ChatGPT.exe）正在运行时应发现它；未运行时输出 no matching process
  assert.ok(
    /found \d+ process|no matching process/.test(output),
    `unexpected output: ${output.slice(0, 200)}`,
  );
});

test(
  "production restart launcher is consoleless and relaunches a sacrificial process",
  { skip: process.platform !== "win32" },
  async () => {
    const drillDir = path.join(root, "drill");
    const fakeExe = path.join(drillDir, "zh-restart-drill-fake.exe");
    const helperLog = path.join(dataDir, "restart-app.log");
    fs.mkdirSync(drillDir, { recursive: true });
    fs.copyFileSync("C:\\Windows\\System32\\PING.EXE", fakeExe);

    const first = spawn(fakeExe, ["-t", "127.0.0.1"], {
      windowsHide: true,
      stdio: "ignore",
    });
    first.unref();
    await new Promise((resolve) => setTimeout(resolve, 800));

    const launched = launchRestartHelper({
      reason: "test-consoleless",
      delaySeconds: 0,
      processName: "zh-restart-drill-fake.exe",
      pathPattern: "",
      exePath: fakeExe,
      exeArgs: ["-t", "127.0.0.1"],
      killWaitMs: 1000,
    });

    try {
      assert.equal(launched.launched, true, JSON.stringify(launched));
      if (!launched.fallback) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const children = spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${launched.pid} } | Select-Object -ExpandProperty Name`,
          ],
          { encoding: "utf8", windowsHide: true, timeout: 10000 },
        );
        assert.doesNotMatch(
          String(children.stdout || ""),
          /conhost\.exe/i,
          "WMI 助手不应分配控制台窗口",
        );
      }
      const deadline = Date.now() + 10000;
      let relaunched = false;
      while (Date.now() < deadline) {
        const listing = spawnSync(
          "tasklist.exe",
          ["/FI", "IMAGENAME eq zh-restart-drill-fake.exe", "/FO", "CSV", "/NH"],
          { encoding: "utf8", windowsHide: true },
        );
        const pids = String(listing.stdout || "")
          .split(/\r?\n/)
          .filter((line) => line.includes("zh-restart-drill-fake.exe"))
          .map((line) => line.split('","')[1])
          .filter(Boolean);
        if (pids.length && !pids.includes(String(first.pid))) {
          relaunched = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      assert.equal(relaunched, true, "牺牲进程应被重新拉起");
      const helperOutput = fs.readFileSync(helperLog, "utf8");
      assert.match(helperOutput, /found 1 process/);
      assert.match(helperOutput, /relaunched pid=/);
    } finally {
      spawnSync("taskkill.exe", ["/F", "/IM", "zh-restart-drill-fake.exe"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
  },
);
