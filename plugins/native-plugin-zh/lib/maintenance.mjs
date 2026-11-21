import fs from "node:fs";
import path from "node:path";

import {
  APP_VERSION,
  CODEX_HOME,
  CONFIG_FILE,
  DATA_DIR,
  PACK_FILE,
  PLUGIN_DIR,
  PLUGIN_ID,
  SETTINGS_FILE,
  STATE_FILE,
  ensureDirs,
  getSettings,
  readJson,
  resolveCodexCommand,
} from "./paths.mjs";
import {
  historyTail,
  readGuardConfigStates,
  readPluginConfigState,
} from "./lifecycle.mjs";
import { cleanupLegacyResidue } from "./migration.mjs";
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

function marketplaceNameFromPluginDir() {
  const parts = path.resolve(PLUGIN_DIR).split(path.sep);
  const cacheIndex = parts.lastIndexOf("cache");
  if (
    cacheIndex > 0 &&
    parts[cacheIndex - 1]?.toLowerCase() === "plugins" &&
    parts.length > cacheIndex + 3
  ) {
    return parts[cacheIndex + 1];
  }
  return null;
}

export function inspectGuardStatus() {
  const marketplace =
    process.env.CODEX_PLUGIN_ZH_MARKETPLACE || marketplaceNameFromPluginDir();
  const states = readGuardConfigStates();
  const expectedId = marketplace
    ? `native-plugin-zh-guard@${marketplace}`
    : null;
  const state =
    states.find((item) => item.pluginId === expectedId) || states[0] || null;
  const pluginId = state?.pluginId || expectedId;
  const cachePath =
    marketplace
      ? path.join(
          CODEX_HOME,
          "plugins",
          "cache",
          marketplace,
          "native-plugin-zh-guard",
        )
      : null;
  const installed =
    states.length > 0 ||
    Boolean(cachePath && fs.existsSync(cachePath));
  return {
    marketplace,
    pluginId,
    installed,
    enabled: state?.enabled === true,
    cachePath,
    hookTrust: pluginId
      ? inspectHookTrustConfig(pluginId)
      : {
          configured: false,
          entries: [],
          note: "尚未找到恢复守护插件；无法检查其 hooks 信任记录。",
        },
    installCommand: pluginId
      ? `codex plugin add ${pluginId}`
      : "codex plugin add native-plugin-zh-guard@<marketplace>",
  };
}

export async function bootstrap() {
  if (process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP === "1") {
    return { skipped: true, reason: "disabled-by-env" };
  }
  ensureDirs();
  const legacy = cleanupLegacyResidue();
  if (!fs.existsSync(STATE_FILE)) saveState(loadState());
  const lifecycle = await startLifecycle({
    reason: "mcp-start",
    trigger: "mcp",
    lockWaitMs: 5000,
  });
  return {
    legacy,
    config: readPluginConfigState(),
    guard: inspectGuardStatus(),
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
  const hookTrust = inspectHookTrustConfig();
  const guard = inspectGuardStatus();
  const payload = {
    appVersion: APP_VERSION,
    dataDir: DATA_DIR,
    pluginDir: PLUGIN_DIR,
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
    guard,
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
    console.log(
      `恢复守护：${
        payload.guard.enabled
          ? "已安装并启用"
          : payload.guard.installed
            ? "已安装但未启用"
            : "未安装"
      }`,
    );
    if (!payload.guard.enabled) {
      console.log(`恢复守护安装命令：${payload.guard.installCommand}`);
    }
    console.log(
      `插件与字段：${payload.sync.localPlugins} / ${
        payload.sync.alreadyChineseFields + payload.sync.pending.length
      }`,
    );
    console.log(`待翻译：${payload.sync.pending}`);
    console.log(`发现方式：${payload.sync.discoverySource || "未知"}`);
  }
  return payload;
}
