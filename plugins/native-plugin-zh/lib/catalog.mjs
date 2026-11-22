import fs from "node:fs";
import path from "node:path";

import {
  CATALOG_FILE,
  TRANSLATION_BACKOFF_MS,
  getSettings,
  logLine,
  nowIso,
  readJson,
  sha256,
  writeJsonAtomic,
} from "./paths.mjs";
import { discoverLocalPlugins } from "./discovery.mjs";
import { readPluginConfigState } from "./lifecycle.mjs";
import { syncWithTranslation } from "./sync.mjs";

const DEFAULT_POLL_MS = 15000;
const DEFAULT_DEBOUNCE_MS = 2500;
const DEFAULT_PENDING_RETRY_MS = 5 * 60 * 1000;

let started = false;

export function autoTranslateUpdatesEnabled(settings = getSettings()) {
  return settings?.autoTranslate !== false;
}

function configuredNumber(value, fallback, minimum = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, number) : fallback;
}

export function catalogPollMs(settings = getSettings()) {
  return configuredNumber(settings.catalogPollMs, DEFAULT_POLL_MS, 500);
}

export function catalogDebounceMs(settings = getSettings()) {
  return configuredNumber(settings.catalogDebounceMs, DEFAULT_DEBOUNCE_MS, 0);
}

function pendingCountOf(result) {
  if (Array.isArray(result?.pending)) return result.pending.length;
  if (Number.isInteger(result?.pending)) return result.pending;
  return null;
}

function pendingRetryDelay(retryMs = null) {
  const base = configuredNumber(retryMs, DEFAULT_PENDING_RETRY_MS, 100);
  const failedAt = Date.parse(getSettings().lastTranslationFailureAt || 0);
  if (Number.isFinite(failedAt)) {
    const remaining = failedAt + TRANSLATION_BACKOFF_MS - Date.now();
    if (remaining > 0) return Math.max(base, remaining + 5000);
  }
  return base;
}

export async function catalogFingerprint({ allowAppServer = false, allowCli = false } = {}) {
  const discovered = await discoverLocalPlugins({
    scope: "all-local",
    allowAppServer,
    allowCli,
  });
  const entries = discovered.plugins
    .map((plugin) => {
      let stat = null;
      let manifestHash = null;
      try {
        const info = fs.statSync(plugin.manifestPath);
        stat = { mtimeMs: Math.round(info.mtimeMs), size: info.size };
        manifestHash = sha256(fs.readFileSync(plugin.manifestPath, "utf8"));
      } catch {}
      return {
        key: plugin.key,
        manifestPath: path.resolve(plugin.manifestPath),
        version: plugin.version || null,
        stat,
        manifestHash,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key, "en"));
  return {
    fingerprint: sha256(JSON.stringify(entries)),
    plugins: entries.length,
    entries,
    errors: discovered.errors,
  };
}

export function readCatalogState() {
  return readJson(CATALOG_FILE, null);
}

function persistCatalog(
  snapshot,
  reason,
  result = null,
  { autoTranslate = undefined, pendingRetryMs = null } = {},
) {
  const previous = readCatalogState() || {};
  const pending = result
    ? pendingCountOf(result)
    : Number.isInteger(previous.pending)
      ? previous.pending
      : null;
  const shouldRetry =
    Number.isInteger(pending) &&
    pending > 0 &&
    (autoTranslate === undefined ? autoTranslateUpdatesEnabled() : autoTranslate === true);
  const nextPendingRetryAt = result
    ? shouldRetry
      ? new Date(Date.now() + pendingRetryDelay(pendingRetryMs)).toISOString()
      : null
    : previous.nextPendingRetryAt || null;
  writeJsonAtomic(CATALOG_FILE, {
    schemaVersion: 1,
    fingerprint: snapshot?.fingerprint || previous.fingerprint || null,
    plugins: snapshot?.plugins ?? result?.plugins ?? previous.plugins ?? null,
    errors:
      snapshot?.errors?.length ??
      result?.errors?.length ??
      previous.errors ??
      0,
    at: nowIso(),
    reason,
    appliedFields: result ? result.appliedFields ?? 0 : previous.appliedFields ?? null,
    pending: pending ?? null,
    translation: result ? result.translation ?? null : previous.translation ?? null,
    nextPendingRetryAt,
  });
}

export function catalogStatus() {
  const settings = getSettings();
  const state = readCatalogState();
  return {
    watcherActive: started,
    autoTranslateUpdates: autoTranslateUpdatesEnabled(settings),
    pollMs: catalogPollMs(settings),
    debounceMs: catalogDebounceMs(settings),
    stateFile: CATALOG_FILE,
    fingerprint: state?.fingerprint ? String(state.fingerprint).slice(0, 16) : null,
    plugins: Number.isInteger(state?.plugins) ? state.plugins : null,
    pending: Number.isInteger(state?.pending) ? state.pending : null,
    appliedFields: Number.isInteger(state?.appliedFields) ? state.appliedFields : null,
    errors: Number.isInteger(state?.errors) ? state.errors : null,
    lastRunAt: state?.at || null,
    lastReason: state?.reason || null,
    nextPendingRetryAt: state?.nextPendingRetryAt || null,
  };
}

export async function syncCatalog({
  reason = "catalog",
  autoTranslate = autoTranslateUpdatesEnabled(),
  translator = null,
  lockWaitMs = 10000,
} = {}) {
  if (!readPluginConfigState().enabled) {
    return {
      skipped: true,
      disabled: true,
      reason: "plugin-disabled-before-lock",
      pending: [],
    };
  }
  const summary = await syncWithTranslation({
    autoTranslate,
    enable: false,
    quiet: true,
    scope: "all-local",
    allowAppServer: false,
    allowCli: false,
    requirePluginEnabled: true,
    lockWaitMs,
    translator,
  });
  return { ...summary, catalogReason: reason };
}

export async function autoTranslatePending({
  reason = "startup",
  translator = null,
  lockWaitMs = 10000,
} = {}) {
  if (!autoTranslateUpdatesEnabled()) {
    return {
      skipped: true,
      disabled: false,
      reason: "disabled-by-settings",
      pending: [],
    };
  }
  return syncCatalog({
    reason,
    autoTranslate: true,
    translator,
    lockWaitMs,
  }).then((result) => {
    if (!result?.skipped) {
      persistCatalog(null, reason, result, { autoTranslate: true });
    }
    return result;
  });
}

export async function startCatalogWatcher({
  pollMs = null,
  debounceMs = null,
  pendingRetryMs = null,
  autoTranslate = undefined,
  runSync = null,
} = {}) {
  if (started) return () => {};
  started = true;

  try {
    const settings = getSettings();
    const intervalMs = configuredNumber(pollMs, catalogPollMs(settings), 500);
    const debounce = configuredNumber(
      debounceMs,
      catalogDebounceMs(settings),
      0,
    );

    const initial = await catalogFingerprint();
    let lastSeen = initial.fingerprint;
    const persisted = readCatalogState();
    let lastPending = Number.isInteger(persisted?.pending) ? persisted.pending : 0;
    let nextPendingRetryAt = Date.parse(persisted?.nextPendingRetryAt || 0);
    if (!Number.isFinite(nextPendingRetryAt)) nextPendingRetryAt = 0;
    if (!persisted || persisted.fingerprint !== lastSeen) {
      persistCatalog(initial, "startup-baseline");
    }

    const syncImpl =
      runSync ||
      (async (context) =>
        syncCatalog({
          reason: context.reason,
          autoTranslate: context.autoTranslate,
        }));

    let closed = false;
    let busy = false;
    let queued = null;
    let timer = null;

    function schedule(reason) {
      if (closed) return;
      queued = { reason, at: Date.now() };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void execute();
      }, debounce);
      timer.unref?.();
    }

    async function execute() {
      if (closed || !queued) return;
      if (busy) {
        schedule(queued.reason);
        return;
      }
      const context = queued;
      queued = null;
      busy = true;
      try {
        const next = await catalogFingerprint();
        const pendingRetry = context.reason === "pending-retry";
        if (!pendingRetry && next.fingerprint === lastSeen) return;
        const alreadyHandled = readCatalogState();
        if (!pendingRetry && alreadyHandled?.fingerprint === next.fingerprint) {
          lastSeen = next.fingerprint;
          return;
        }
        const shouldTranslate =
          autoTranslate === undefined ? autoTranslateUpdatesEnabled() : autoTranslate;
        const result = await syncImpl({
          reason: context.reason,
          autoTranslate: shouldTranslate,
          fingerprint: next.fingerprint,
          plugins: next.plugins,
        });
        if (result?.skipped) {
          if (result.disabled === true) {
            logLine(
              `catalog ${context.reason}: 插件已关闭，保留清单指纹等待重新启用`,
            );
            return;
          }
          logLine(
            `catalog ${context.reason}: 同步被跳过（${result.reason || "locked"}），稍后重试`,
          );
          return;
        }
        lastSeen = next.fingerprint;
        const pending = pendingCountOf(result);
        if (Number.isInteger(pending)) {
          lastPending = pending;
          nextPendingRetryAt =
            pending > 0 && shouldTranslate
              ? Date.now() + pendingRetryDelay(pendingRetryMs)
              : 0;
        }
        persistCatalog(next, context.reason, result, {
          autoTranslate: shouldTranslate,
          pendingRetryMs,
        });
        logLine(
          `catalog ${context.reason}: plugins=${next.plugins} applied=${
            result?.appliedFields ?? 0
          } pending=${result?.pending?.length ?? 0}`,
        );
      } catch (error) {
        logLine(`catalog ${context.reason} 失败：${error.stack || error.message}`);
      } finally {
        busy = false;
        if (queued && !closed) schedule(queued.reason);
      }
    }

    const pollTimer = setInterval(() => {
      if (closed || busy || timer) return;
      if (!readPluginConfigState().enabled) return;
      const state = readCatalogState();
      if (Number.isInteger(state?.pending)) {
        lastPending = state.pending;
        const retryAt = Date.parse(state.nextPendingRetryAt || 0);
        if (Number.isFinite(retryAt)) nextPendingRetryAt = retryAt;
      }
      const shouldTranslate =
        autoTranslate === undefined ? autoTranslateUpdatesEnabled() : autoTranslate;
      if (
        shouldTranslate &&
        lastPending > 0 &&
        (!nextPendingRetryAt || Date.now() >= nextPendingRetryAt)
      ) {
        schedule("pending-retry");
        return;
      }
      void catalogFingerprint()
        .then((next) => {
          if (next.fingerprint !== lastSeen) {
            schedule("catalog-change");
          } else if (
            shouldTranslate &&
            lastPending > 0 &&
            (!nextPendingRetryAt || Date.now() >= nextPendingRetryAt)
          ) {
            schedule("pending-retry");
          }
        })
        .catch((error) => logLine(`catalog 轮询失败：${error.message}`));
    }, intervalMs);
    pollTimer.unref?.();

    logLine(
      `catalog: 已开始监听插件清单（本地源与安装缓存，${initial.plugins} 个插件，poll=${intervalMs}ms，debounce=${debounce}ms）`,
    );

    return () => {
      closed = true;
      clearInterval(pollTimer);
      if (timer) clearTimeout(timer);
      started = false;
      logLine("catalog: 已停止监听插件清单");
    };
  } catch (error) {
    started = false;
    throw error;
  }
}
