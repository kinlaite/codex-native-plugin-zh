import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";

import {
  APP_VERSION,
  CODEX_HOME,
  isObject,
  logLine,
  normalizeFsPath,
  resolveCodexCommand,
  stringValue,
} from "./paths.mjs";
import { manifestPathFor } from "./storage.mjs";

function runCodexCliJson(args, timeout = 30000) {
  const result = spawnSync(resolveCodexCommand(), args, {
    windowsHide: true,
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = stringValue(result.stderr || result.stdout).trim();
    throw new Error(`codex ${args.join(" ")} 失败: ${detail.slice(-1200)}`);
  }
  try {
    return JSON.parse(stringValue(result.stdout));
  } catch {
    throw new Error(`codex ${args.join(" ")} 未返回有效 JSON`);
  }
}

function runAppServerOnce(method, params = {}) {
  return new Promise((resolve, reject) => {
    const command = resolveCodexCommand();
    const child = spawn(command, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let stderr = "";
    const timer = setTimeout(() => finish(new Error("codex app-server 超时")), 30000);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      if (error) {
        const detail = stderr.trim();
        reject(new Error(detail ? `${error.message}: ${detail.slice(-1200)}` : error.message));
      } else {
        resolve(value);
      }
    }

    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`codex app-server 提前退出，退出码 ${code}`));
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    const send = (message) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) {
          finish(new Error(`initialize 失败: ${JSON.stringify(message.error)}`));
          return;
        }
        send({ jsonrpc: "2.0", id: 2, method, params });
        return;
      }
      if (message.id === 2) {
        if (message.error) {
          finish(new Error(`${method} 失败: ${JSON.stringify(message.error)}`));
          return;
        }
        finish(null, message.result);
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "native-plugin-zh",
          title: "Native Plugin Chinese",
          version: APP_VERSION,
        },
        capabilities: null,
      },
    });
  });
}

function pluginKey(marketplace, name) {
  return `${marketplace}/${name}`;
}

function collectInstalledPlugins({ allowCli = true } = {}) {
  const plugins = new Map();
  if (!allowCli) return plugins;
  try {
    const result = runCodexCliJson(["plugin", "list", "--json"]);
    for (const plugin of [...(result.installed || []), ...(result.available || [])]) {
      const name = stringValue(plugin.name);
      const marketplace = stringValue(plugin.marketplaceName || plugin.marketplace);
      if (!name || !marketplace) continue;
      const key = pluginKey(marketplace, name);
      plugins.set(key, {
        key,
        version: stringValue(plugin.version) || null,
      });
    }
  } catch {}
  return plugins;
}

function installedCacheRoots() {
  const roots = [
    path.join(CODEX_HOME, "plugins", "cache"),
    path.join(os.homedir(), "plugins", "cache"),
  ];
  const seen = new Set();
  return roots.filter((root) => {
    const identity = path.resolve(root).toLowerCase();
    if (seen.has(identity) || !fs.existsSync(root)) return false;
    seen.add(identity);
    return true;
  });
}

function parseConfigMarketplaceRoots() {
  const roots = [];
  let text = "";
  try {
    text = fs.readFileSync(path.join(CODEX_HOME, "config.toml"), "utf8");
  } catch {
    return roots;
  }
  const lines = text.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const header = line.match(/^\s*\[marketplaces\.(.+?)\]\s*$/);
    if (header) {
      if (current?.sourceType === "local" && current.source) roots.push(current);
      current = { name: header[1].replace(/^"(.*)"$/, "$1"), sourceType: "", source: "" };
      continue;
    }
    if (/^\s*\[/.test(line)) {
      if (current?.sourceType === "local" && current.source) roots.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const sourceType = line.match(/^\s*source_type\s*=\s*["']([^"']+)["']/);
    if (sourceType) current.sourceType = sourceType[1];
    const source = line.match(/^\s*source\s*=\s*["']([^"']+)["']/);
    if (source) current.source = normalizeFsPath(source[1]);
  }
  if (current?.sourceType === "local" && current.source) roots.push(current);
  return roots;
}

function findMarketplaceMetadataRoots(base, maxDepth) {
  const roots = [];
  const seen = new Set();

  function walk(directory, depth) {
    if (depth > maxDepth) return;
    let real;
    try {
      real = fs.realpathSync(directory);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);

    const metadata = path.join(directory, ".agents", "plugins", "marketplace.json");
    if (fs.existsSync(metadata)) roots.push(directory);

    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (["node_modules", "cache", "backups", ".git", "plugins"].includes(entry.name)) continue;
      walk(path.join(directory, entry.name), depth + 1);
    }
  }

  walk(base, 0);
  return roots;
}

function marketplaceRoots({ allowCli = true } = {}) {
  const roots = [];
  const seen = new Set();

  function add(name, root) {
    const normalized = normalizeFsPath(root);
    if (!normalized) return;
    const identity = path.resolve(normalized).toLowerCase();
    if (seen.has(identity)) return;
    seen.add(identity);
    roots.push({ name, root: normalized });
  }

  if (allowCli) {
    try {
      const result = runCodexCliJson(["plugin", "marketplace", "list", "--json"]);
      for (const item of result.marketplaces || []) {
        add(stringValue(item.name), item.root);
      }
    } catch {}
  }

  for (const item of parseConfigMarketplaceRoots()) add(item.name, item.source);

  const known = [
    ["openai-bundled", path.join(CODEX_HOME, ".tmp", "bundled-marketplaces", "openai-bundled")],
    ["openai-api-curated", path.join(CODEX_HOME, ".tmp", "plugins")],
  ];
  for (const [name, root] of known) {
    if (fs.existsSync(root)) add(name, root);
  }

  try {
    const runtimeRoot = path.join(os.homedir(), ".cache", "codex-runtimes");
    for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pluginsRoot = path.join(runtimeRoot, entry.name, "plugins");
      if (!fs.existsSync(pluginsRoot)) continue;
      for (const marketplace of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
        if (marketplace.isDirectory()) {
          add(marketplace.name, path.join(pluginsRoot, marketplace.name));
        }
      }
    }
  } catch {}

  for (const root of findMarketplaceMetadataRoots(CODEX_HOME, 4)) {
    const metadata = path.join(root, ".agents", "plugins", "marketplace.json");
    const parsed = (() => {
      try {
        return JSON.parse(fs.readFileSync(metadata, "utf8"));
      } catch {
        return null;
      }
    })();
    add(stringValue(parsed?.name) || path.basename(root), root);
  }

  return roots;
}

function readMarketplacePluginEntries(root) {
  const metadata = path.join(root, ".agents", "plugins", "marketplace.json");
  if (!fs.existsSync(metadata)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(metadata, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed?.plugins)) return [];
  return parsed.plugins
    .map((item) => {
      const name = stringValue(item?.name);
      const relative =
        stringValue(item?.source?.path) ||
        (item?.source?.source === "local" ? stringValue(item.source.path) : "");
      if (!name || !relative) return null;
      return { name, directory: path.resolve(root, relative) };
    })
    .filter(Boolean);
}

function candidatePluginDirectories(root) {
  const candidates = new Map();
  const add = (directory, fallbackName = null) => {
    const normalized = path.resolve(directory);
    if (!candidates.has(normalized.toLowerCase())) {
      candidates.set(normalized.toLowerCase(), { directory: normalized, fallbackName });
    }
  };

  for (const item of readMarketplacePluginEntries(root)) add(item.directory, item.name);

  const pluginsRoot = path.join(root, "plugins");
  for (const base of [pluginsRoot, root]) {
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (base === root && entry.name === "plugins") continue;
        add(path.join(base, entry.name), entry.name);
      }
    } catch {}
  }
  return [...candidates.values()];
}

function scanMarketplaceRoots(installedKeys, options = {}) {
  const found = [];
  const errors = [];
  for (const { name, root } of marketplaceRoots(options)) {
    if (!fs.existsSync(root)) continue;
    for (const candidate of candidatePluginDirectories(root)) {
      try {
        const manifestPath = manifestPathFor(candidate.directory);
        if (!manifestPath) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const pluginName = stringValue(manifest.name) || candidate.fallbackName;
        if (!pluginName) continue;
        const key = pluginKey(name, pluginName);
        found.push({
          key,
          marketplace: name,
          pluginName,
          sourcePath: candidate.directory,
          manifestPath,
          version: stringValue(manifest.version) || null,
          installed: installedKeys.has(key),
        });
      } catch (error) {
        errors.push({ key: `${name}/${candidate.fallbackName || "?"}`, message: error.message });
      }
    }
  }
  return { plugins: found, errors };
}

function scanInstalledCacheRoots(installedPlugins, { includeAll = false } = {}) {
  const found = [];
  const errors = [];
  const byKey = new Map();

  for (const root of installedCacheRoots()) {
    let marketplaces = [];
    try {
      marketplaces = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const marketplaceEntry of marketplaces) {
      if (!marketplaceEntry.isDirectory()) continue;
      const marketplace = marketplaceEntry.name;
      const marketplaceRoot = path.join(root, marketplace);
      let pluginEntries = [];
      try {
        pluginEntries = fs.readdirSync(marketplaceRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const pluginEntry of pluginEntries) {
        if (!pluginEntry.isDirectory()) continue;
        const pluginRoot = path.join(marketplaceRoot, pluginEntry.name);
        const candidates = [pluginRoot];
        try {
          for (const versionEntry of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
            if (versionEntry.isDirectory()) {
              candidates.push(path.join(pluginRoot, versionEntry.name));
            }
          }
        } catch {}

        for (const candidate of candidates) {
          try {
            const manifestPath = manifestPathFor(candidate);
            if (!manifestPath) continue;
            const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            const pluginName =
              stringValue(manifest.name) || pluginEntry.name;
            if (!pluginName) continue;
            const key = pluginKey(marketplace, pluginName);
            const installed = installedPlugins.get(key) || null;
            if (!includeAll && !installed) continue;
            const manifestStat = fs.statSync(manifestPath);
            const version = stringValue(manifest.version) || null;
            const versionMatch =
              !!installed?.version &&
              (installed.version === version ||
                installed.version === path.basename(candidate));
            const score = {
              versionMatch: versionMatch ? 1 : 0,
              mtimeMs: Math.round(manifestStat.mtimeMs),
            };
            const previous = byKey.get(key);
            if (
              previous &&
              (previous.score.versionMatch > score.versionMatch ||
                (previous.score.versionMatch === score.versionMatch &&
                  previous.score.mtimeMs >= score.mtimeMs))
            ) {
              continue;
            }
            byKey.set(key, {
              score,
              plugin: {
                key,
                marketplace,
                pluginName,
                sourcePath: candidate,
                manifestPath,
                version,
                installed: true,
              },
            });
          } catch (error) {
            errors.push({
              key: `${marketplace}/${pluginEntry.name}`,
              message: error.message,
            });
          }
        }
      }
    }
  }

  found.push(...[...byKey.values()].map((entry) => entry.plugin));
  return { plugins: found, errors };
}

function normalizeAppServerResult(result, scope) {
  const plugins = [];
  let remoteSkipped = 0;
  for (const marketplace of result?.marketplaces || []) {
    for (const plugin of marketplace?.plugins || []) {
      if (scope === "installed-only" && (plugin.installed !== true || plugin.enabled === false)) {
        continue;
      }
      if (plugin.source?.type !== "local" || !plugin.source?.path) {
        remoteSkipped += 1;
        continue;
      }
      const sourcePath = normalizeFsPath(plugin.source.path);
      if (!path.isAbsolute(sourcePath)) {
        remoteSkipped += 1;
        continue;
      }
      const manifestPath = manifestPathFor(sourcePath);
      if (!manifestPath) continue;
      plugins.push({
        key: pluginKey(marketplace.name, plugin.name),
        marketplace: stringValue(marketplace.name),
        pluginName: stringValue(plugin.name),
        sourcePath,
        manifestPath,
        version: plugin.localVersion || plugin.version || null,
        installed: plugin.installed === true,
      });
    }
  }
  return { plugins, remoteSkipped };
}

export async function discoverLocalPlugins({
  scope = "all-local",
  allowAppServer = true,
  allowCli = true,
} = {}) {
  const errors = [];
  const byKey = new Map();
  let remoteSkipped = 0;
  let appServerUsed = false;

  const method = scope === "installed-only" ? "plugin/installed" : "plugin/list";
  if (allowAppServer) {
    try {
      let result;
      try {
        result = await runAppServerOnce(
          method,
          scope === "all-local" ? { forceRefetch: true } : {},
        );
      } catch (error) {
        if (scope !== "all-local") throw error;
        result = await runAppServerOnce(method, {});
      }
      const normalized = normalizeAppServerResult(result, scope);
      remoteSkipped = normalized.remoteSkipped;
      for (const plugin of normalized.plugins) byKey.set(plugin.key, plugin);
      appServerUsed = true;
    } catch (error) {
      errors.push({ stage: "app-server", message: error.message });
      logLine(`app-server 发现失败，改用文件扫描：${error.message}`);
    }
  }

  const installedPlugins = collectInstalledPlugins({ allowCli });
  const installedKeys = new Set(installedPlugins.keys());
  const scanned = scanMarketplaceRoots(installedKeys, { allowCli });
  errors.push(...scanned.errors.map((item) => ({ stage: "scan", ...item })));
  for (const plugin of scanned.plugins) {
    const previous = byKey.get(plugin.key);
    if (previous) {
      previous.installed = previous.installed || plugin.installed;
      if (!previous.manifestPath && plugin.manifestPath) Object.assign(previous, plugin);
      continue;
    }
    if (scope === "installed-only" && !plugin.installed) continue;
    byKey.set(plugin.key, plugin);
  }

  const cached = scanInstalledCacheRoots(installedPlugins, {
    includeAll: !allowCli,
  });
  errors.push(...cached.errors.map((item) => ({ stage: "cache-scan", ...item })));
  for (const plugin of cached.plugins) {
    if (scope === "installed-only" && !plugin.installed) continue;
    if (byKey.has(plugin.key)) continue;
    byKey.set(plugin.key, plugin);
  }

  const plugins = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key, "en"));
  return {
    plugins,
    remoteSkipped,
    appServerUsed,
    errors,
    source: appServerUsed ? "app-server+filesystem" : "filesystem",
  };
}
