#!/usr/bin/env node
import { logLine } from "../lib/paths.mjs";
import { readPluginConfigState } from "../lib/lifecycle.mjs";
import {
  bootstrap,
  diagnose,
  purgeDataAfterRestore,
} from "../lib/maintenance.mjs";
import { cleanupLegacyResidue } from "../lib/migration.mjs";
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
  node scripts/cli.mjs uninstall [--purge]
  node scripts/cli.mjs cleanup-legacy
  node scripts/cli.mjs bootstrap
  node scripts/cli.mjs diagnose [--json]

说明：
  apply         启用覆盖并把已有中文写入来源清单
  sync          重新发现并同步中文；--translate 增量翻译
  restore       手动恢复原清单并暂停中文化
  uninstall     恢复英文并按需清除本地运行数据
  cleanup-legacy 删除旧版计划任务和稳定运行目录
  bootstrap     按插件开关执行一次启停生命周期
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
    const result = await bootstrap();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "cleanup-legacy") {
    console.log(JSON.stringify(cleanupLegacyResidue(), null, 2));
    return;
  }
  if (command === "diagnose") {
    await diagnose({ json });
    return;
  }
  if (command === "restore") {
    cleanupLegacyResidue();
    await restoreOriginals({
      force: flags.has("force"),
      preserveIntent: false,
      lastPluginConfigEnabled: readPluginConfigState().enabled,
      reason: "manual-cli",
      trigger: "cli",
    });
    return;
  }
  if (command === "uninstall") {
    cleanupLegacyResidue();
    const restored = await restoreOriginals({
      force: flags.has("force"),
      preserveIntent: false,
      lastPluginConfigEnabled: readPluginConfigState().enabled,
      reason: "uninstall",
      trigger: "cli",
    });
    const purgeResult = purgeDataAfterRestore(restored, {
      purge: flags.has("purge"),
    });
    if (flags.has("purge") && !purgeResult.purged) process.exitCode = 1;
    console.log(
      JSON.stringify(
        { restored, ...purgeResult },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "apply" || command === "sync") {
    const result = await syncWithTranslation({
      dryRun: flags.has("dry-run"),
      enable: command === "apply" && !flags.has("dry-run"),
      lastPluginConfigEnabled:
        command === "apply" && !flags.has("dry-run")
          ? readPluginConfigState().enabled
          : undefined,
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
