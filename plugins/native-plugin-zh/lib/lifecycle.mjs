import fs from "node:fs";

import {
  CONFIG_FILE,
  HISTORY_FILE,
  PLUGIN_ID,
  ensureDirs,
  nowIso,
  stringValue,
} from "./paths.mjs";

function unquoteTomlKey(value) {
  const text = stringValue(value).trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function sectionPluginId(header) {
  const match = header.match(/^\s*\[\s*plugins\.(.+?)\s*\]\s*(?:#.*)?$/);
  if (!match) return null;
  return unquoteTomlKey(match[1]);
}

export function parsePluginConfigState(text, pluginId = PLUGIN_ID) {
  const result = {
    pluginId,
    found: false,
    enabled: false,
    enabledLine: null,
  };
  let inPluginSection = false;
  for (const line of stringValue(text).split(/\r?\n/)) {
    const header = line.match(/^\s*\[[^\]]+\]\s*(?:#.*)?$/);
    if (header) {
      const id = sectionPluginId(line);
      inPluginSection = id === pluginId;
      if (inPluginSection) result.found = true;
      continue;
    }
    if (!inPluginSection) continue;
    const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/i);
    if (!enabled) continue;
    result.enabled = enabled[1].toLowerCase() === "true";
    result.enabledLine = line.trim();
  }
  return result;
}

export function readPluginConfigState(pluginId = PLUGIN_ID) {
  let text = "";
  try {
    text = fs.readFileSync(CONFIG_FILE, "utf8");
  } catch {}
  const marketplacePrefix = `${pluginId.split("@")[0]}@`;
  const entries = listPluginConfigStates(
    text,
    (candidate) => candidate === pluginId || candidate.startsWith(marketplacePrefix),
  );
  const exact = entries.find((entry) => entry.pluginId === pluginId);
  const preferred =
    exact || entries.find((entry) => entry.enabled) || entries[0] || null;
  return {
    pluginId: preferred?.pluginId || pluginId,
    found: entries.length > 0,
    enabled: entries.some((entry) => entry.enabled),
    enabledLine: preferred?.enabledLine || null,
    configFile: CONFIG_FILE,
  };
}

export function listPluginConfigStates(text, predicate = () => true) {
  const entries = [];
  let current = null;
  for (const line of stringValue(text).split(/\r?\n/)) {
    const header = line.match(/^\s*\[[^\]]+\]\s*(?:#.*)?$/);
    if (header) {
      const id = sectionPluginId(line);
      if (id && predicate(id)) {
        current = { pluginId: id, found: true, enabled: false, enabledLine: null };
        entries.push(current);
      } else {
        current = null;
      }
      continue;
    }
    if (!current) continue;
    const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/i);
    if (enabled) {
      current.enabled = enabled[1].toLowerCase() === "true";
      current.enabledLine = line.trim();
    }
  }
  return entries;
}

export function appendHistory(record) {
  try {
    ensureDirs();
    if (fs.existsSync(HISTORY_FILE) && fs.statSync(HISTORY_FILE).size > 2 * 1024 * 1024) {
      const previous = `${HISTORY_FILE}.1`;
      try {
        fs.unlinkSync(previous);
      } catch {}
      fs.renameSync(HISTORY_FILE, previous);
    }
    fs.appendFileSync(
      HISTORY_FILE,
      `${JSON.stringify({ at: nowIso(), ...record })}\n`,
      "utf8",
    );
  } catch {}
}

export function historyTail(limit = 12) {
  try {
    const lines = fs
      .readFileSync(HISTORY_FILE, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    return lines.slice(-Math.max(1, limit)).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    return [];
  }
}
