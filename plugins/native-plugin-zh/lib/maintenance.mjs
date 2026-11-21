import fs from "node:fs";
import path from "node:path";

import {
  APP_VERSION,
  CODEX_HOME,
  CONFIG_FILE,
  DATA_DIR,
  PACK_FILE,
  PLUGIN_ID,
  SETTINGS_FILE,
  STATE_FILE,
  ensureDirs,
  getSettings,
  readJson,
  resolveCodexCommand,
} from "./paths.mjs";
import { historyTail, readPluginConfigState } from "./lifecycle.mjs";
import { cleanupLegacyResidue } from "./migration.mjs";
import {
  ensureRestoreServerRegistered,
  syncRestoreServerBin,
} from "./registration.mjs";
import { startLifecycle } from "./runtime.mjs";
import { status } from "./sync.mjs";
import { loadPack, loadState, packStats, saveState } from "./storage.mjs";

function inspectHookTrustConfig(pluginId = PLUGIN_ID) {
  let text = "";
  try {
    text = fs.readFileSync(CONFIG_FILE, "utf8");
  } catch {}
  const prefix = `${pluginId}:hooks/hooks.json:`;
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[hooks\.state\."(.+?)"\]\s*$/);
    if (header) {
      current = { key: header[1], trustedHash: null, trustedContentHash: null };
      if (header[1].startsWith(prefix)) entries.push(current);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const trusted = line.match(/^\s*trusted_hash\s*=\s*["']([^"']+)["']/);
    if (trusted) current.trustedHash = trusted[1];
    const content = line.match(/^\s*trusted_content_hash\s*=\s*["']([^"']+)["']/);
    if (content) current.trustedContentHash = content[1];
  }
  return {
    configured: entries.length > 0,
    entries,
    note:
      entries.length > 0
        ? "已有 hooks 信任记录；插件内容变化后 Codex 会再次要求批准。"
        : "尚未批准插件 hooks；首次启用后需在 Codex 中批准一次。",
  };
}

// 关闭恢复不再依赖第二个插件：MCP 服务器进程内监听 config.toml，
// 加上进程回收前的最后机会检查。这里只报告监听能力，供诊断展示。
function inspectWatcherAvailability() {
  let writable = false;
  try {
    fs.accessSync(path.dirname(CONFIG_FILE), fs.constants.R_OK);
    fs.readFileSync(CONFIG_FILE, "utf8");
    writable = true;
  } catch {}
  return {
    configReadable: writable,
    available: writable,
    note: writable
      ? "运行中的 MCP 服务器会监听插件开关变化并立即恢复英文；进程被回收前还有最后一次检查。"
      : "无法读取 config.toml，关闭后的自动恢复将依赖下一次启动检查或 CLI。",
  };
}

export async function bootstrap() {
  if (process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP === "1") {
    return { skipped: true, reason: "disabled-by-env" };
  }
  ensureDirs();
  const legacy = cleanupLegacyResidue();
  if (!fs.existsSync(STATE_FILE)) saveState(loadState());
  // 恢复兜底脚本同步到数据目录；插件开关启用时确保 config.toml 注册存在。
  // 关闭插件后该注册仍在，Codex 每次启动拉起它完成英文恢复。
  const restoreServer = { synced: syncRestoreServerBin() };
  if (readPluginConfigState().enabled) {
    restoreServer.registration = ensureRestoreServerRegistered();
  }
  const lifecycle = await startLifecycle({
    reason: "mcp-start",
    trigger: "mcp",
    lockWaitMs: 5000,
  });
  return {
    legacy,
    restoreServer,
    config: readPluginConfigState(),
    watcher: inspectWatcherAvailability(),
    lifecycle,
  };
}

export function purgeDataAfterRestore(restored, { purge = false } = {}) {
  if (!purge) {
    return { purged: false, reason: "not-requested" };
  }
  if (!restored || restored.skipped) {
    return { purged: false, reason: "restore-skipped" };
  }
  if ((restored.conflicts || []).length) {
    return { purged: false, reason: "restore-conflicts" };
  }
  if ((restored.errors || []).length) {
    return { purged: false, reason: "restore-errors" };
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  return { purged: true, reason: null };
}

export async function diagnose({ json = false, quiet = false } = {}) {
  const config = readPluginConfigState();
  const state = loadState();
  const syncStatus = await status({ json: false, quiet: true });
  const pack = loadPack();
  const codexBin = resolveCodexCommand({ save: true });
  const setting = getSettings();
  const hookTrust = inspectHookTrustConfig(config.pluginId);
  const watcher = inspectWatcherAvailability();
  const payload = {
    appVersion: APP_VERSION,
    dataDir: DATA_DIR,
    codexHome: CODEX_HOME,
    configFile: CONFIG_FILE,
    pluginConfig: config,
    codexBin,
    codexBinExists: codexBin !== "codex" && fs.existsSync(codexBin),
    nodeBin: setting.nodeBin || process.execPath,
    nodeBinExists: fs.existsSync(setting.nodeBin || process.execPath),
    enabled: state.enabled,
    overlayActive: state.overlayActive === true,
    lastPluginConfigEnabled:
      typeof state.lastPluginConfigEnabled === "boolean"
        ? state.lastPluginConfigEnabled
        : null,
    stateFile: STATE_FILE,
    packFile: PACK_FILE,
    packStats: packStats(pack),
    hookTrust,
    watcher,
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
    history: historyTail(8),
    lastTranslationFailureAt: readJson(SETTINGS_FILE, null)?.lastTranslationFailureAt || null,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (!quiet) {
    console.log(`插件版本：${payload.appVersion}`);
    console.log(`Codex：${payload.codexBin}（${payload.codexBinExists ? "存在" : "需重新定位"}）`);
    console.log(`Node：${payload.nodeBin}（${payload.nodeBinExists ? "存在" : "缺失"}）`);
    console.log(
      `Codex 插件开关：${
        payload.pluginConfig.enabled
          ? "已启用"
          : payload.pluginConfig.found
            ? "已关闭"
            : "未配置"
      }`,
    );
    console.log(`中文化偏好：${payload.enabled ? "已启用" : "已暂停"}`);
    console.log(`中文覆盖：${payload.overlayActive ? "已生效" : "未生效"}`);
    console.log(`插件 hooks：${payload.hookTrust.configured ? "已写入信任记录" : "待批准"}`);
    console.log(`关闭恢复监听：${payload.watcher.available ? "可用" : "受限"}`);
    console.log(
      `插件与字段：${payload.sync.localPlugins} / ${
        payload.sync.alreadyChineseFields + payload.sync.pending
      }`,
    );
    console.log(`待翻译：${payload.sync.pending}`);
    console.log(`发现方式：${payload.sync.discoverySource || "未知"}`);
  }
  return payload;
}
