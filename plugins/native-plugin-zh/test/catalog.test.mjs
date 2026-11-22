import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-catalog-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(codexHome, "plugin-i18n-native");
const marketplaceRoot = path.join(root, "marketplace");
const pluginsRoot = path.join(marketplaceRoot, "plugins");
const browserRoot = path.join(pluginsRoot, "browser");
const calendarRoot = path.join(pluginsRoot, "calendar");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(browserRoot), { recursive: true });
fs.writeFileSync(
  path.join(codexHome, "config.toml"),
  [
    '[plugins."native-plugin-zh@native-plugin-zh-local"]',
    "enabled = true",
    "",
    "[marketplaces.openai-bundled]",
    'source_type = "local"',
    `source = '${marketplaceRoot.replaceAll("\\", "/")}'`,
    "",
  ].join("\n"),
  "utf8",
);

process.env.CODEX_HOME = codexHome;
process.env.CODEX_PLUGIN_ZH_DATA_DIR = dataDir;
process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP = "1";
process.env.USERPROFILE = root;
process.env.HOME = root;

const {
  autoTranslateUpdatesEnabled,
  catalogFingerprint,
  startCatalogWatcher,
} = await import("../lib/catalog.mjs");

function setPluginEnabled(enabled) {
  const configFile = path.join(codexHome, "config.toml");
  const content = fs.readFileSync(configFile, "utf8");
  fs.writeFileSync(
    configFile,
    content.replace(/enabled = (true|false)/, `enabled = ${enabled}`),
    "utf8",
  );
}

function writeManifest(directory, name, shortDescription) {
  fs.mkdirSync(path.join(directory, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, ".codex-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name,
        interface: {
          displayName: name,
          shortDescription,
          longDescription: `${shortDescription} long`,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function resetCatalog() {
  setPluginEnabled(true);
  fs.rmSync(calendarRoot, { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, "catalog-state.json"), { force: true });
  fs.writeFileSync(path.join(dataDir, "settings.json"), "{}\n", "utf8");
  writeManifest(browserRoot, "browser", "Browse the web");
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return false;
}

test("catalog fingerprint changes when a new plugin appears", async () => {
  resetCatalog();
  const first = await catalogFingerprint({ allowAppServer: false, allowCli: false });
  writeManifest(calendarRoot, "calendar", "Plan the week");
  const second = await catalogFingerprint({ allowAppServer: false, allowCli: false });
  assert.equal(first.plugins, 1);
  assert.equal(second.plugins, 2);
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("catalog fingerprint detects content edits even when stat is unchanged", async () => {
  resetCatalog();
  const manifestPath = path.join(browserRoot, ".codex-plugin", "plugin.json");
  const beforeStat = fs.statSync(manifestPath);
  const first = await catalogFingerprint({ allowAppServer: false, allowCli: false });
  const content = fs.readFileSync(manifestPath, "utf8");
  fs.writeFileSync(
    manifestPath,
    content.replace("Browse the web", "Browse the Web"),
    "utf8",
  );
  fs.utimesSync(manifestPath, beforeStat.atime, beforeStat.mtime);
  const second = await catalogFingerprint({ allowAppServer: false, allowCli: false });
  assert.equal(beforeStat.size, fs.statSync(manifestPath).size);
  assert.equal(
    Math.round(beforeStat.mtimeMs),
    Math.round(fs.statSync(manifestPath).mtimeMs),
  );
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("catalog watcher triggers auto sync for a new plugin and changed manifest", async () => {
  resetCatalog();
  const calls = [];
  const stop = await startCatalogWatcher({
    pollMs: 40,
    debounceMs: 20,
    autoTranslate: true,
    runSync: async (context) => {
      calls.push(context);
      return { skipped: false, pending: [] };
    },
  });

  try {
    writeManifest(calendarRoot, "calendar", "Plan the week");
    assert.equal(
      await waitFor(() => calls.length >= 1),
      true,
      "新插件应触发后台同步",
    );
    assert.equal(calls[0].autoTranslate, true);

    await new Promise((resolve) => setTimeout(resolve, 80));
    writeManifest(calendarRoot, "calendar", "Plan the week and meetings");
    assert.equal(
      await waitFor(() => calls.length >= 2),
      true,
      "插件清单变化应触发后台同步",
    );
  } finally {
    stop();
  }
});

test("catalog watcher retries pending translation without another manifest change", async () => {
  resetCatalog();
  const calls = [];
  const stop = await startCatalogWatcher({
    pollMs: 100,
    debounceMs: 20,
    pendingRetryMs: 100,
    autoTranslate: true,
    runSync: async (context) => {
      calls.push(context);
      return {
        skipped: false,
        pending: calls.length === 1 ? [{ key: "audit/plugin", field: "displayName" }] : [],
      };
    },
  });

  try {
    writeManifest(calendarRoot, "calendar", "Plan the week");
    assert.equal(
      await waitFor(() => calls.length >= 2),
      true,
      "待翻译字段应在退避到期后自动重试",
    );
    assert.equal(calls[1].reason, "pending-retry");
  } finally {
    stop();
  }
});

test("catalog watcher does not retry pending when auto translation is off", async () => {
  resetCatalog();
  const calls = [];
  const stop = await startCatalogWatcher({
    pollMs: 100,
    debounceMs: 20,
    pendingRetryMs: 100,
    autoTranslate: false,
    runSync: async (context) => {
      calls.push(context);
      return {
        skipped: false,
        pending: [{ key: "audit/plugin", field: "displayName" }],
      };
    },
  });

  try {
    writeManifest(calendarRoot, "calendar", "Plan the week");
    assert.equal(await waitFor(() => calls.length >= 1), true);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(calls.length, 1);
  } finally {
    stop();
  }
});

test("catalog watcher detects changes that happened while the plugin was off", async () => {
  resetCatalog();
  const calls = [];
  const stop = await startCatalogWatcher({
    pollMs: 100,
    debounceMs: 20,
    autoTranslate: true,
    runSync: async (context) => {
      calls.push(context);
      return { skipped: false, pending: [] };
    },
  });

  try {
    setPluginEnabled(false);
    writeManifest(calendarRoot, "calendar", "Plan the week");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(calls.length, 0);
    setPluginEnabled(true);
    assert.equal(
      await waitFor(() => calls.length >= 1),
      true,
      "重新启用后应补上停机期间的新插件",
    );
  } finally {
    setPluginEnabled(true);
    stop();
  }
});

test("catalog watcher honors autoTranslate false", async () => {
  resetCatalog();
  const calls = [];
  const stop = await startCatalogWatcher({
    pollMs: 40,
    debounceMs: 20,
    autoTranslate: false,
    runSync: async (context) => {
      calls.push(context);
      return { skipped: false, pending: [] };
    },
  });

  try {
    writeManifest(calendarRoot, "calendar", "Plan the week");
    assert.equal(
      await waitFor(() => calls.length >= 1),
      true,
      "关闭自动翻译时仍应同步缓存",
    );
    assert.equal(calls[0].autoTranslate, false);
  } finally {
    stop();
  }
});

test("autoTranslateUpdatesEnabled defaults on and honors false", () => {
  const settingsFile = path.join(dataDir, "settings.json");
  fs.writeFileSync(settingsFile, "{}\n", "utf8");
  assert.equal(autoTranslateUpdatesEnabled(), true);
  fs.writeFileSync(settingsFile, '{"autoTranslate":false}\n', "utf8");
  assert.equal(autoTranslateUpdatesEnabled(), false);
});

test("cleans up the catalog fixture", () => {
  fs.rmSync(root, { recursive: true, force: true });
});
