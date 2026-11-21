import fs from "node:fs";
import path from "node:path";

import {
  BACKUP_DIR,
  FIELDS,
  LOCALE,
  MAP_FILE,
  PACK_FILE,
  SEED_FILE,
  STATE_FILE,
  ensureDirs,
  firstNonEmpty,
  hasHan,
  isObject,
  nowIso,
  readJson,
  sha256,
  stringValue,
  writeJsonAtomic,
  writeTextAtomic,
} from "./paths.mjs";

export function loadState() {
  const state = readJson(STATE_FILE, null);
  if (!isObject(state)) {
    return {
      schemaVersion: 2,
      locale: LOCALE,
      enabled: true,
      overlayActive: false,
      lastSyncAt: null,
      plugins: {},
    };
  }
  state.plugins = isObject(state.plugins) ? state.plugins : {};
  if (typeof state.enabled !== "boolean") state.enabled = true;
  if (typeof state.overlayActive !== "boolean") {
    state.overlayActive = Object.values(state.plugins).some((entry) => {
      if (!entry?.lastAppliedAt) return false;
      return !entry.lastRestoredAt || entry.lastAppliedAt > entry.lastRestoredAt;
    });
  }
  state.schemaVersion = 2;
  return state;
}

export function loadStateInfo() {
  const raw = readJson(STATE_FILE, null);
  return {
    state: loadState(),
    persisted: isObject(raw),
    hadLifecycleMarker:
      isObject(raw) && typeof raw.lastPluginConfigEnabled === "boolean",
  };
}

export function saveState(state) {
  writeJsonAtomic(STATE_FILE, state);
}

function packFieldsFromSeed(sourceFields) {
  const fields = {};
  for (const field of FIELDS) {
    const entry = sourceFields?.[field];
    if (!isObject(entry)) continue;
    const text = stringValue(entry.text);
    const sourceHash = stringValue(entry.sourceHash);
    if (!text || !/^[a-f0-9]{64}$/i.test(sourceHash)) continue;
    fields[field] = {
      sourceHash,
      text,
      origin: stringValue(entry.origin) || "seed",
      updatedAt: entry.updatedAt || nowIso(),
    };
  }
  return fields;
}

export function normalizePack(seed) {
  const sourcePlugins = isObject(seed?.plugins) ? seed.plugins : {};
  const plugins = {};
  for (const [key, plugin] of Object.entries(sourcePlugins)) {
    const sourceFields = isObject(plugin?.fields) ? plugin.fields : plugin;
    const fields = packFieldsFromSeed(sourceFields);
    if (Object.keys(fields).length) plugins[key] = fields;
  }
  return {
    schemaVersion: 1,
    locale: LOCALE,
    updatedAt: nowIso(),
    plugins,
  };
}

function mergeMissingSeedEntries(pack, seed) {
  const normalized = normalizePack(seed);
  for (const [key, fields] of Object.entries(normalized.plugins)) {
    if (!isObject(pack.plugins[key])) pack.plugins[key] = {};
    for (const [field, entry] of Object.entries(fields)) {
      const existing = pack.plugins[key][field];
      if (!isObject(existing) || !/^[a-f0-9]{64}$/i.test(stringValue(existing.sourceHash))) {
        pack.plugins[key][field] = entry;
      }
    }
  }
}

export function loadPack({ persist = true } = {}) {
  ensureDirs();
  const existing = readJson(PACK_FILE, null);
  if (isObject(existing)) {
    existing.plugins = isObject(existing.plugins) ? existing.plugins : {};
    const seed = readJson(SEED_FILE, null);
    if (seed) mergeMissingSeedEntries(existing, seed);
    return existing;
  }

  const seed = readJson(SEED_FILE, null);
  if (!seed) {
    const empty = {
      schemaVersion: 1,
      locale: LOCALE,
      updatedAt: nowIso(),
      plugins: {},
    };
    if (persist) writeJsonAtomic(PACK_FILE, empty);
    return empty;
  }

  const pack = normalizePack(seed);
  const map = readJson(MAP_FILE, null);
  if (isObject(map)) {
    for (const [key, plugin] of Object.entries(map)) {
      if (!pack.plugins[key]) pack.plugins[key] = {};
      for (const field of FIELDS) {
        if (!pack.plugins[key][field] && stringValue(plugin?.[field])) {
          pack.plugins[key][field] = {
            sourceHash: null,
            text: stringValue(plugin[field]),
            origin: "legacy-map",
            updatedAt: nowIso(),
          };
        }
      }
    }
  }
  if (persist) writeJsonAtomic(PACK_FILE, pack);
  return pack;
}

export function savePack(pack) {
  pack.updatedAt = nowIso();
  writeJsonAtomic(PACK_FILE, pack);
}

export function packTranslation(pack, key, field, sourceHash) {
  const entry = pack?.plugins?.[key]?.[field];
  if (!entry || entry.sourceHash !== sourceHash) return null;
  const text = stringValue(entry.text);
  return text || null;
}

export function packStats(pack) {
  let plugins = 0;
  let fields = 0;
  for (const plugin of Object.values(pack?.plugins || {})) {
    let count = 0;
    for (const field of FIELDS) {
      if (stringValue(plugin?.[field]?.text)) count += 1;
    }
    if (count) {
      plugins += 1;
      fields += count;
    }
  }
  return { plugins, fields };
}

export function readManifest(manifestPath) {
  const buffer = fs.readFileSync(manifestPath);
  const hasBom =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  let text = buffer.toString("utf8");
  if (hasBom && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const obj = JSON.parse(text);
  if (!isObject(obj)) throw new Error("plugin.json 顶层不是对象");
  return {
    manifestPath,
    text,
    obj,
    hasBom,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    trailingNewline: /\r?\n$/.test(text),
    hasInterface: isObject(obj.interface),
  };
}

export function serializeManifest(manifest, obj) {
  let text = JSON.stringify(obj, null, 2);
  if (manifest.eol === "\r\n") text = text.replaceAll("\n", "\r\n");
  if (manifest.trailingNewline) text += manifest.eol;
  if (manifest.hasBom) text = `\ufeff${text}`;
  return text;
}

export function manifestPathFor(sourcePath) {
  const codexPlugin = path.join(sourcePath, ".codex-plugin", "plugin.json");
  if (fs.existsSync(codexPlugin)) return codexPlugin;
  const rootPlugin = path.join(sourcePath, "plugin.json");
  if (fs.existsSync(rootPlugin)) return rootPlugin;
  return null;
}

export function sourceDefaults(obj, plugin) {
  const iface = isObject(obj.interface) ? obj.interface : {};
  const description = stringValue(obj.description);
  return {
    displayName: firstNonEmpty(iface.displayName, obj.displayName, obj.name, plugin.pluginName),
    shortDescription: firstNonEmpty(
      iface.shortDescription,
      description,
      iface.longDescription,
      obj.displayName,
    ),
    longDescription: firstNonEmpty(
      iface.longDescription,
      description,
      iface.shortDescription,
      obj.displayName,
    ),
  };
}

export function currentFieldValue(obj, field) {
  if (!isObject(obj.interface)) return null;
  if (!Object.prototype.hasOwnProperty.call(obj.interface, field)) return null;
  const value = obj.interface[field];
  return typeof value === "string" ? value : null;
}

export function makeStateEntry(plugin, manifest) {
  return {
    key: plugin.key,
    marketplace: plugin.marketplace,
    pluginName: plugin.pluginName,
    sourcePath: plugin.sourcePath,
    manifestPath: plugin.manifestPath,
    interfaceExisted: manifest.hasInterface,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastAppliedAt: null,
    backupFile: null,
    fields: {},
  };
}

function backupFileName(key) {
  return `${key.replace(/[^a-zA-Z0-9._-]+/g, "__")}.json`;
}

function cleanBackupObject(manifest, entry, sourceFields) {
  const obj = structuredClone(manifest.obj);
  for (const field of FIELDS) {
    const previous = entry.fields?.[field];
    if (!previous) continue;
    const present = previous.originalPresent === true;
    if (!present) {
      if (
        isObject(obj.interface) &&
        Object.prototype.hasOwnProperty.call(obj.interface, field)
      ) {
        delete obj.interface[field];
      }
      continue;
    }
    if (!isObject(obj.interface)) obj.interface = {};
    obj.interface[field] =
      stringValue(sourceFields?.[field]) ||
      stringValue(previous.originalValue);
  }
  if (
    isObject(obj.interface) &&
    Object.keys(obj.interface).length === 0 &&
    manifest.hasInterface === false
  ) {
    delete obj.interface;
  }
  return obj;
}

export function saveBackup(entry, manifest, sourceFields, reason) {
  ensureDirs();
  const file = path.join(BACKUP_DIR, backupFileName(entry.key));
  const originalFields = {};
  for (const field of FIELDS) {
    const previous = entry.fields?.[field];
    if (!previous) continue;
    originalFields[field] = {
      present: previous.originalPresent === true,
      value: stringValue(previous.originalValue) || null,
    };
  }
  const cleanObject = cleanBackupObject(manifest, entry, sourceFields);
  const record = {
    schemaVersion: 2,
    key: entry.key,
    marketplace: entry.marketplace,
    pluginName: entry.pluginName,
    manifestPath: entry.manifestPath,
    sourcePath: entry.sourcePath,
    savedAt: nowIso(),
    reason,
    interfaceExisted: manifest.hasInterface,
    sourceFields,
    originalFields,
    originalText: serializeManifest(manifest, cleanObject),
  };
  writeJsonAtomic(file, record);
  entry.backupFile = file;
  return file;
}

export function listBackupRecords() {
  ensureDirs();
  const records = [];
  let names = [];
  try {
    names = fs.readdirSync(BACKUP_DIR);
  } catch {
    return records;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(BACKUP_DIR, name);
    const record = readJson(file, null);
    if (
      !isObject(record) ||
      !stringValue(record.key) ||
      !stringValue(record.manifestPath) ||
      !isObject(record.sourceFields)
    ) {
      continue;
    }
    records.push({ ...record, backupFile: file });
  }
  return records;
}

export function recoverEntryFromBackup(record, pack) {
  let original;
  try {
    original = JSON.parse(stringValue(record.originalText));
  } catch {
    original = null;
  }
  const originalInterface = isObject(original?.interface) ? original.interface : {};
  const fields = {};
  for (const field of FIELDS) {
    const source = stringValue(record.sourceFields?.[field]);
    if (!source || hasHan(source)) continue;
    const previous = record.originalFields?.[field];
    const originalPresent =
      isObject(previous) && typeof previous.present === "boolean"
        ? previous.present
        : Object.prototype.hasOwnProperty.call(originalInterface, field);
    const storedOriginal = stringValue(previous?.value);
    const originalValue = originalPresent
      ? (!hasHan(storedOriginal) && storedOriginal) ||
        source ||
        (typeof originalInterface[field] === "string" ? originalInterface[field] : null)
      : null;
    const sourceHash = sha256(source);
    fields[field] = {
      source,
      sourceHash,
      translation: packTranslation(pack, record.key, field, sourceHash),
      originalPresent,
      originalValue,
    };
  }
  if (!Object.keys(fields).length) return null;
  return {
    key: record.key,
    marketplace: record.marketplace,
    pluginName: record.pluginName,
    sourcePath: record.sourcePath,
    manifestPath: record.manifestPath,
    interfaceExisted: record.interfaceExisted === true,
    backupFile: record.backupFile,
    recoveredFromBackup: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    fields,
  };
}

export function applyFields(manifest, fields) {
  const obj = structuredClone(manifest.obj);
  if (!isObject(obj.interface)) obj.interface = {};
  const changed = [];
  for (const { field, value } of fields) {
    if (obj.interface[field] === value) continue;
    obj.interface[field] = value;
    changed.push(field);
  }
  if (!changed.length) return { changed, text: manifest.text };
  return { changed, text: serializeManifest(manifest, obj) };
}

export function writeManifest(manifestPath, text) {
  writeTextAtomic(manifestPath, text);
}

export function shouldRefreshField(previous, raw, defaults, field) {
  if (!previous) {
    const source = raw !== null ? raw : defaults[field] || "";
    return {
      source,
      sourceHash: sha256(source),
      originalPresent: raw !== null,
      originalValue: raw,
      changed: true,
    };
  }

  if (previous.translation !== null && raw === previous.translation) {
    return {
      source: previous.source,
      sourceHash: previous.sourceHash,
      originalPresent: previous.originalPresent === true,
      originalValue: previous.originalValue ?? null,
      changed: false,
    };
  }

  if (raw !== null && raw === previous.source) {
    return {
      source: previous.source,
      sourceHash: previous.sourceHash,
      originalPresent: previous.originalPresent === true,
      originalValue: previous.originalValue ?? null,
      changed: false,
    };
  }

  if (raw === null) {
    const fallback = defaults[field] || "";
    if (fallback && fallback !== previous.source) {
      return {
        source: fallback,
        sourceHash: sha256(fallback),
        originalPresent: false,
        originalValue: null,
        changed: true,
      };
    }
    return {
      source: previous.source,
      sourceHash: previous.sourceHash,
      originalPresent: previous.originalPresent === true,
      originalValue: previous.originalValue ?? null,
      changed: false,
    };
  }

  return {
    source: raw,
    sourceHash: sha256(raw),
    originalPresent: true,
    originalValue: raw,
    changed: true,
  };
}
