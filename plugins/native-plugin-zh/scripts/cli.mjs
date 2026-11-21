#!/usr/bin/env node
import { logLine } from "../lib/paths.mjs";
import {
  bootstrap,
  diagnose,
  installAutoSync,
  uninstallAutoSync,
} from "../lib/tasks.mjs";
import {
  restoreOriginals,
  status,
  syncWithTranslation,
} from "../lib/sync.mjs";

function parseArguments(argv) {
  const command = argv[0] || "status";
  const flags = new Set();
  const values = {};
  for (const arg of argv.slice(1)) {
    if (!arg.startsWith("--")) continue;
    const index = arg.indexOf("=");
    if (index === -1) flags.add(arg.slice(2));
    else values[arg.slice(2, index)] = arg.slice(index + 1);
  }
  return { command, flags, values };
}

function printHelp() {
  console.log(`Codex 原生插件中文化

用法：
  node scripts/cli.mjs status [--json] [--installed-only]
  node scripts/cli.mjs apply [--translate] [--dry-run] [--json]
  node scripts/cli.mjs sync [--translate] [--dry-run] [--installed-only] [--json]
  node scripts/cli.mjs restore [--force]
  node scripts/cli.mjs install-task [--force]
  node scripts/cli.mjs uninstall-task
  node scripts/cli.mjs bootstrap
  node scripts/cli.mjs diagnose [--json]

说明：
  apply         启用覆盖并把已有中文写入来源清单
  sync          重新发现并同步中文；--translate 增量翻译
  restore       恢复原清单并暂停自动同步
  install-task  创建登录触发、每 5 分钟运行的隐藏任务
  bootstrap     同步稳定运行时代码、安装任务并应用缓存
`);
}

async function main() {
  const { command, flags } = parseArguments(process.argv.slice(2));
  const json = flags.has("json");
  const scope = flags.has("installed-only") ? "installed-only" : "all-local";

  if (command === "help" || flags.has("help")) {
    printHelp();
    return;
  }
  if (command === "status") {
    await status({ json, scope });
    return;
  }
  if (command === "bootstrap") {
    const result = await bootstrap({ syncCached: true });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "diagnose") {
    await diagnose({ json });
    return;
  }
  if (command === "restore") {
    await restoreOriginals({ force: flags.has("force") });
    return;
  }
  if (command === "install-task") {
    const result = installAutoSync({ force: flags.has("force") });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "uninstall-task") {
    const result = uninstallAutoSync();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "apply" || command === "sync") {
    const result = await syncWithTranslation({
      dryRun: flags.has("dry-run"),
      enable: command === "apply" && !flags.has("dry-run"),
      autoTranslate: flags.has("translate"),
      forceTranslate: flags.has("translate"),
      quiet: flags.has("quiet") || json,
      scope,
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (result.skipped) console.log("已有同步进程在运行，本次跳过。");
    return;
  }
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  logLine(`CLI 失败：${error.stack || error.message}`);
  console.error(error.message);
  process.exitCode = 1;
});
