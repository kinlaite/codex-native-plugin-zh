import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  FIELDS,
  PACK_FILE,
  SCHEMA_FILE,
  SETTINGS_FILE,
  STATE_FILE,
  TRANSLATION_BACKOFF_MS,
  ensureDirs,
  firstNonEmpty,
  hasHan,
  isObject,
  logLine,
  nowIso,
  readJson,
  resolveCodexCommand,
  stringValue,
  updateSettings,
  withLock,
  writeJsonAtomic,
  writeTextAtomic,
} from "./paths.mjs";
import { discoverLocalPlugins } from "./discovery.mjs";
import {
  applyFields,
  currentFieldValue,
  loadPack,
  loadState,
  makeStateEntry,
  packStats,
  packTranslation,
  readManifest,
  saveBackup,
  savePack,
  saveState,
  serializeManifest,
  shouldRefreshField,
  sourceDefaults,
  writeManifest,
} from "./storage.mjs";

function emptySummary(overrides = {}) {
  return {
    disabled: false,
    plugins: 0,
    installedPlugins: 0,
    remoteSkipped: 0,
    changedPlugins: 0,
    appliedFields: 0,
    alreadyChineseFields: 0,
    pending: [],
    errors: [],
    discoveryErrors: [],
    results: [],
    discoverySource: null,
    ...overrides,
  };
}

export async function syncInstalled({
  dryRun = false,
  quiet = false,
  scope = "all-local",
  ignoreDisabled = false,
} = {}) {
  const state = loadState();
  if (!state.enabled && !ignoreDisabled) {
    return emptySummary({ disabled: true });
  }

  const pack = loadPack();
  const discovered = await discoverLocalPlugins({ scope });
  const plugins = discovered.plugins;
  const pendingMap = new Map();
  const results = [];
  const errors = [...discovered.errors];
  let changedPlugins = 0;
  let appliedFields = 0;
  let alreadyChineseFields = 0;

  for (const plugin of plugins) {
    try {
      const manifest = readManifest(plugin.manifestPath);
      let entry = state.plugins[plugin.key];
      let pathChanged = false;
      if (!entry) {
        entry = makeStateEntry(plugin, manifest);
        state.plugins[plugin.key] = entry;
      } else {
        pathChanged =
          path.resolve(entry.manifestPath || "") !== path.resolve(plugin.manifestPath);
        entry.sourcePath = plugin.sourcePath;
        entry.manifestPath = plugin.manifestPath;
      }

      entry.marketplace = plugin.marketplace;
      entry.pluginName = plugin.pluginName;
      entry.updatedAt = nowIso();
      entry.version = plugin.version;

      const defaults = sourceDefaults(manifest.obj, plugin);
      let sourceChanged = false;
      let englishSourceChanged = false;
      const fieldsToWrite = [];
      const pluginPending = [];

      for (const field of FIELDS) {
        const raw = currentFieldValue(manifest.obj, field);
        const previous = entry.fields[field];
        const refreshed = shouldRefreshField(previous, raw, defaults, field);
        if (refreshed.changed) {
          sourceChanged = true;
          if (!hasHan(refreshed.source)) englishSourceChanged = true;
        }

        const next = {
          source: refreshed.source,
          sourceHash: refreshed.sourceHash,
          translation: refreshed.changed ? null : previous?.translation ?? null,
          originalPresent: refreshed.originalPresent,
          originalValue: refreshed.originalValue,
          updatedAt: refreshed.changed ? nowIso() : previous?.updatedAt || nowIso(),
        };

        if (hasHan(next.source)) {
          next.translation = next.source;
          next.alreadyChinese = true;
          alreadyChineseFields += 1;
        } else {
          const translated = packTranslation(pack, plugin.key, field, next.sourceHash);
          if (translated) {
            next.translation = translated;
          } else if (!next.translation && next.source) {
            pluginPending.push({
              id: `${plugin.key}|${field}`,
              key: plugin.key,
              marketplace: plugin.marketplace,
              pluginName: plugin.pluginName,
              field,
              source: next.source,
              sourceHash: next.sourceHash,
            });
          }
        }

        entry.fields[field] = next;
        if (next.translation && next.translation !== raw) {
          fieldsToWrite.push({ field, value: next.translation });
        }
      }

      if ((englishSourceChanged || pathChanged) && !dryRun) {
        saveBackup(
          entry,
          manifest,
          Object.fromEntries(FIELDS.map((field) => [field, entry.fields[field]?.source || ""])),
          pathChanged
            ? "source-path-updated"
            : entry.lastAppliedAt
              ? "source-updated"
              : "first-apply",
        );
      }

      let applied = [];
      if (fieldsToWrite.length) {
        const output = applyFields(manifest, fieldsToWrite);
        applied = output.changed;
        if (!dryRun && applied.length) {
          writeManifest(plugin.manifestPath, output.text);
          entry.lastAppliedAt = nowIso();
        }
      }

      for (const item of pluginPending) {
        pendingMap.set(`${item.key}\0${item.field}\0${item.sourceHash}`, item);
      }
      if (applied.length) {
        changedPlugins += 1;
        appliedFields += applied.length;
      }

      results.push({
        key: plugin.key,
        version: plugin.version,
        sourcePath: plugin.sourcePath,
        manifestPath: plugin.manifestPath,
        applied,
        pending: pluginPending.map((item) => item.field),
      });
    } catch (error) {
      errors.push({ stage: "sync", key: plugin.key, message: error.message });
      logLine(`错误 ${plugin.key}: ${error.message}`);
    }
  }

  const summary = emptySummary({
    plugins: plugins.length,
    installedPlugins: plugins.filter((plugin) => plugin.installed).length,
    remoteSkipped: discovered.remoteSkipped,
    changedPlugins,
    appliedFields,
    alreadyChineseFields,
    pending: [...pendingMap.values()],
    errors,
    discoveryErrors: discovered.errors,
    results,
    discoverySource: discovered.source,
  });

  if (!dryRun) {
    state.lastSyncAt = nowIso();
    state.lastSummary = {
      plugins: plugins.length,
      installedPlugins: summary.installedPlugins,
      remoteSkipped: discovered.remoteSkipped,
      changedPlugins,
      appliedFields,
      alreadyChineseFields,
      pending: summary.pending.length,
      errors: errors.length,
      discoverySource: discovered.source,
    };
    saveState(state);
  }

  if (!quiet) {
    const label = dryRun ? "预计修改" : "更新";
    console.log(
      `已扫描 ${plugins.length} 个本地插件；${label} ${changedPlugins} 个插件、${appliedFields} 个字段。`,
    );
    if (alreadyChineseFields) console.log(`跳过中文源字段：${alreadyChineseFields}`);
    if (summary.pending.length) {
      console.log(`待翻译字段：${summary.pending.length}`);
      for (const item of summary.pending.slice(0, 20)) {
        console.log(`- ${item.key} / ${item.field}`);
      }
      if (summary.pending.length > 20) console.log("- 其余字段省略");
    }
    if (errors.length) {
      console.log(`错误：${errors.length}`);
      for (const item of errors.slice(0, 20)) {
        console.log(`- ${item.key || item.stage}: ${item.message}`);
      }
    }
  }

  return summary;
}

function translationPrompt(items) {
  const payload = items.map(({ id, pluginName, field, source }) => ({
    id,
    plugin: pluginName,
    field,
    text: source,
  }));
  return [
    "Translate Codex plugin UI copy from English to Simplified Chinese.",
    "Rules:",
    "1. Return exactly one translation for every input id.",
    "2. Keep product names, commands, file extensions, URLs, acronyms, Markdown, and placeholders intact.",
    "3. Use concise, natural Simplified Chinese suitable for a settings page.",
    "4. Do not add explanations, notes, or commentary.",
    "5. Return only JSON matching the provided output schema.",
    "",
    JSON.stringify({ items: payload }, null, 2),
  ].join("\n");
}

function translationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      translations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            text: { type: "string" },
          },
          required: ["id", "text"],
        },
      },
    },
    required: ["translations"],
  };
}

function parseJsonOutput(text) {
  const trimmed = stringValue(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("翻译结果不是有效 JSON");
}

function runCodexExec(args, prompt, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    const child = spawn(resolveCodexCommand({ save: true }), args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve({ code: -1, stdout, stderr: `${stderr}\n翻译超时` });
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 20000) stdout = stdout.slice(-20000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function translateBatchWithCodex(batch) {
  if (!batch.length) return { translated: 0, failed: 0 };
  ensureDirs();
  writeJsonAtomic(SCHEMA_FILE, translationSchema());
  const outputFile = path.join(
    path.dirname(PACK_FILE),
    `translation-${process.pid}-${Date.now()}.json`,
  );
  const workDir = path.join(path.dirname(PACK_FILE), "translator-work");
  fs.mkdirSync(workDir, { recursive: true });
  const prompt = translationPrompt(batch);
  const baseArgs = ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", workDir];
  let result = await runCodexExec(
    [
      ...baseArgs,
      "--output-schema",
      SCHEMA_FILE,
      "--output-last-message",
      outputFile,
      "-",
    ],
    prompt,
  );

  if (
    result.code !== 0 &&
    /(unexpected|unrecognized|unknown).{0,40}(argument|option)|output-schema/i.test(result.stderr)
  ) {
    logLine("当前 Codex 不支持 --output-schema，改用纯 JSON 输出重试");
    result = await runCodexExec([...baseArgs, "-"], prompt);
  }

  if (result.code !== 0) {
    logLine(`Codex 翻译失败 code=${result.code}: ${result.stderr.trim().slice(-1200)}`);
    throw new Error(`Codex 翻译失败，退出码 ${result.code}`);
  }

  const parsed = fs.existsSync(outputFile)
    ? parseJsonOutput(fs.readFileSync(outputFile, "utf8"))
    : parseJsonOutput(result.stdout);

  let items = [];
  if (Array.isArray(parsed?.translations)) items = parsed.translations;
  else if (isObject(parsed?.translations)) {
    items = Object.entries(parsed.translations).map(([id, text]) => ({ id, text }));
  } else if (Array.isArray(parsed?.items)) items = parsed.items;

  const byId = new Map(
    items
      .filter((item) => isObject(item) && stringValue(item.id))
      .map((item) => [
        stringValue(item.id),
        firstNonEmpty(item.text, item.translation, item.translatedText).trim(),
      ])
      .filter(([, text]) => text),
  );

  const pack = loadPack();
  let translated = 0;
  for (const item of batch) {
    const text = byId.get(item.id);
    if (!text) continue;
    if (!pack.plugins[item.key]) pack.plugins[item.key] = {};
    pack.plugins[item.key][item.field] = {
      sourceHash: item.sourceHash,
      text,
      origin: "codex",
      updatedAt: nowIso(),
    };
    translated += 1;
  }
  savePack(pack);
  if (!translated) {
    writeJsonAtomic(path.join(path.dirname(PACK_FILE), "translation-debug.json"), {
      savedAt: nowIso(),
      parsed,
      stdout: result.stdout.slice(-8000),
      stderr: result.stderr.slice(-8000),
      expectedIds: batch.map((item) => item.id),
    });
  }
  try {
    fs.unlinkSync(outputFile);
  } catch {}
  logLine(`Codex 翻译完成 ${translated}/${batch.length}`);
  return { translated, failed: batch.length - translated };
}

function chunkTranslationItems(items) {
  const chunks = [];
  let chunk = [];
  let characters = 0;
  for (const item of items) {
    const length = item.source.length;
    if (chunk.length && (chunk.length >= 20 || characters + length > 12000)) {
      chunks.push(chunk);
      chunk = [];
      characters = 0;
    }
    chunk.push(item);
    characters += length;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

async function translateWithCodex(items) {
  const unique = new Map();
  for (const item of items) {
    if (item.source.trim() && !hasHan(item.source)) unique.set(item.id, item);
  }
  const batches = chunkTranslationItems([...unique.values()]);
  let translated = 0;
  let failed = 0;
  for (const batch of batches) {
    try {
      const result = await translateBatchWithCodex(batch);
      translated += result.translated;
      failed += result.failed;
    } catch (error) {
      failed += batch.length;
      logLine(`翻译批次失败：${error.message}`);
      break;
    }
  }
  return { translated, failed, attempted: unique.size };
}

function translationBackoffActive() {
  const settings = readJson(SETTINGS_FILE, null);
  const failedAt = Date.parse(settings?.lastTranslationFailureAt || 0);
  return Number.isFinite(failedAt) && Date.now() - failedAt < TRANSLATION_BACKOFF_MS;
}

async function syncWithTranslationUnlocked({
  dryRun = false,
  autoTranslate = false,
  quiet = false,
  scope = "all-local",
  forceTranslate = false,
  enable = false,
} = {}) {
  if (enable && !dryRun) {
    const state = loadState();
    if (!state.enabled) {
      state.enabled = true;
      saveState(state);
    }
  }
  let summary = await syncInstalled({ dryRun, quiet, scope });
  if (summary.disabled || dryRun || !autoTranslate || !summary.pending.length) {
    return summary;
  }
  if (!forceTranslate && translationBackoffActive()) {
    return {
      ...summary,
      translation: { attempted: 0, translated: 0, failed: 0, backoff: true },
    };
  }

  const translation = await translateWithCodex(summary.pending);
  if (translation.translated > 0) {
    updateSettings({ lastTranslationFailureAt: null, lastTranslationSuccessAt: nowIso() });
    summary = await syncInstalled({ dryRun: false, quiet, scope });
  } else if (translation.attempted > 0) {
    updateSettings({ lastTranslationFailureAt: nowIso() });
  }
  return { ...summary, translation };
}

export async function syncWithTranslation(options = {}) {
  if (options.dryRun === true) {
    return syncWithTranslationUnlocked({ ...options, enable: false });
  }
  const result = await withLock(() => syncWithTranslationUnlocked(options));
  if (result?.skipped) {
    const state = loadState();
    return emptySummary({
      skipped: true,
      reason: result.reason,
      enabled: state.enabled,
      disabled: !state.enabled,
    });
  }
  return result;
}

function restoreOriginalsUnlocked({ force = false, quiet = false } = {}) {
  const state = loadState();
  state.enabled = false;
  saveState(state);
  let restoredPlugins = 0;
  let restoredFields = 0;
  const errors = [];
  const conflicts = [];

  for (const entry of Object.values(state.plugins)) {
    try {
      if (!entry?.manifestPath || !fs.existsSync(entry.manifestPath)) continue;
      const manifest = readManifest(entry.manifestPath);
      const obj = structuredClone(manifest.obj);
      let changed = false;

      for (const field of FIELDS) {
        const previous = entry.fields?.[field];
        if (!previous) continue;
        const raw = currentFieldValue(obj, field);
        if (
          !force &&
          previous.translation !== null &&
          raw !== null &&
          raw !== previous.translation
        ) {
          conflicts.push({ key: entry.key, field, current: raw });
          continue;
        }

        if (previous.originalPresent) {
          if (!isObject(obj.interface)) obj.interface = {};
          if (obj.interface[field] !== previous.originalValue) {
            obj.interface[field] = previous.originalValue;
            changed = true;
            restoredFields += 1;
          }
        } else if (
          isObject(obj.interface) &&
          Object.prototype.hasOwnProperty.call(obj.interface, field)
        ) {
          delete obj.interface[field];
          changed = true;
          restoredFields += 1;
        }
      }

      if (
        isObject(obj.interface) &&
        Object.keys(obj.interface).length === 0 &&
        entry.interfaceExisted === false
      ) {
        delete obj.interface;
        changed = true;
      }

      if (changed) {
        writeTextAtomic(entry.manifestPath, serializeManifest(manifest, obj));
        restoredPlugins += 1;
      }
      entry.lastRestoredAt = nowIso();
    } catch (error) {
      errors.push({ key: entry.key, message: error.message });
    }
  }

  saveState(state);
  if (!quiet) {
    console.log(`已恢复 ${restoredPlugins} 个插件、${restoredFields} 个字段；自动同步已暂停。`);
    if (conflicts.length) {
      console.log(`跳过 ${conflicts.length} 个已被外部修改的字段：`);
      for (const item of conflicts) console.log(`- ${item.key} / ${item.field}`);
    }
    if (errors.length) {
      console.log(`错误：${errors.length}`);
      for (const item of errors) console.log(`- ${item.key}: ${item.message}`);
    }
  }
  return { restoredPlugins, restoredFields, conflicts, errors };
}

export async function restoreOriginals(options = {}) {
  const result = await withLock(() => restoreOriginalsUnlocked(options));
  if (result?.skipped) {
    return {
      skipped: true,
      reason: result.reason,
      restoredPlugins: 0,
      restoredFields: 0,
      conflicts: [],
      errors: [],
    };
  }
  return result;
}

export async function status({ json = false, scope = "all-local", quiet = false } = {}) {
  const state = loadState();
  const summary = await syncInstalled({
    dryRun: true,
    quiet: true,
    scope,
    ignoreDisabled: true,
  });
  const pack = loadPack({ persist: false });
  const payload = {
    enabled: state.enabled,
    locale: "zh-CN",
    translationsFile: PACK_FILE,
    stateFile: STATE_FILE,
    translationStats: packStats(pack),
    localPlugins: summary.plugins,
    installedPlugins: summary.installedPlugins,
    remoteSkipped: summary.remoteSkipped,
    plannedPlugins: summary.changedPlugins,
    plannedFields: summary.appliedFields,
    alreadyChineseFields: summary.alreadyChineseFields,
    pending: summary.pending,
    errors: summary.errors,
    discoverySource: summary.discoverySource,
    lastSyncAt: state.lastSyncAt || null,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }
  if (quiet) return payload;

  console.log(`自动同步：${state.enabled ? "已启用" : "已暂停"}`);
  console.log(
    `本地插件：${payload.localPlugins}（已安装 ${payload.installedPlugins}，可安装 ${
      payload.localPlugins - payload.installedPlugins
    }）`,
  );
  if (payload.remoteSkipped) console.log(`跳过非本地来源：${payload.remoteSkipped}`);
  console.log(`等待写入：${payload.plannedPlugins} 个插件 / ${payload.plannedFields} 个字段`);
  console.log(`待翻译：${payload.pending.length}`);
  console.log(`跳过中文源字段：${payload.alreadyChineseFields}`);
  console.log(
    `翻译缓存：${payload.translationStats.plugins} 个插件 / ${payload.translationStats.fields} 个字段`,
  );
  console.log(`发现方式：${payload.discoverySource || "未知"}`);
  console.log(`翻译缓存文件：${PACK_FILE}`);
  console.log(`状态文件：${STATE_FILE}`);
  if (payload.lastSyncAt) console.log(`上次同步：${payload.lastSyncAt}`);
  if (payload.pending.length) {
    for (const item of payload.pending) console.log(`- ${item.key} / ${item.field}`);
  }
  if (payload.errors.length) {
    for (const item of payload.errors) {
      console.log(`- ${item.key || item.stage}: ${item.message}`);
    }
  }
  return payload;
}
