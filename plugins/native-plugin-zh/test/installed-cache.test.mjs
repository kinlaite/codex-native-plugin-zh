import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-installed-cache-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(codexHome, "plugin-i18n-native");
const pluginRoot = path.join(
  codexHome,
  "plugins",
  "cache",
  "remote-market",
  "qodo",
  "d420d130",
);
const manifestPath = path.join(pluginRoot, "plugin.json");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(pluginRoot, { recursive: true });
fs.writeFileSync(
  path.join(codexHome, "config.toml"),
  [
    '[plugins."native-plugin-zh@native-plugin-zh-local"]',
    "enabled = true",
    "",
  ].join("\n"),
  "utf8",
);

process.env.CODEX_HOME = codexHome;
process.env.CODEX_PLUGIN_ZH_DATA_DIR = dataDir;
process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP = "1";
process.env.USERPROFILE = root;
process.env.HOME = root;

const { catalogFingerprint, startCatalogWatcher } = await import(
  "../lib/catalog.mjs"
);
const { discoverLocalPlugins } = await import("../lib/discovery.mjs");
const { PACK_FILE } = await import("../lib/paths.mjs");
const { restoreOriginals, syncWithTranslation } = await import("../lib/sync.mjs");
const { loadState } = await import("../lib/storage.mjs");

function writeManifest(shortDescription) {
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        name: "qodo",
        version: "2.3.2",
        description: "Code intelligence and review",
        interface: {
          displayName: "Qodo",
          shortDescription,
          longDescription: "Qodo setup, code intelligence, and review workflows.",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function manifestInterface() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")).interface;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return false;
}

async function fakeTranslator(items) {
  const pack = JSON.parse(fs.readFileSync(PACK_FILE, "utf8"));
  for (const item of items) {
    pack.plugins[item.key] ||= {};
    pack.plugins[item.key][item.field] = {
      sourceHash: item.sourceHash,
      text: `中:${item.field}`,
      origin: "test",
      updatedAt: new Date().toISOString(),
    };
  }
  fs.writeFileSync(PACK_FILE, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  return { attempted: items.length, translated: items.length, failed: 0 };
}

test("discovers and fingerprints a plugin materialized in the install cache", async () => {
  writeManifest("Code intelligence and review");
  const discovered = await discoverLocalPlugins({
    allowAppServer: false,
    allowCli: false,
  });
  const qodo = discovered.plugins.find(
    (plugin) => plugin.key === "remote-market/qodo",
  );
  assert.ok(qodo);
  assert.equal(qodo.manifestPath, manifestPath);
  assert.equal(qodo.installed, true);

  const catalog = await catalogFingerprint({
    allowAppServer: false,
    allowCli: false,
  });
  assert.equal(catalog.plugins, 1);
});

test("catalog watcher notices a newly installed remote plugin", async () => {
  fs.rmSync(path.join(codexHome, "plugins"), { recursive: true, force: true });
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
    assert.equal(calls.length, 0);
    fs.mkdirSync(pluginRoot, { recursive: true });
    writeManifest("Code intelligence and review");
    assert.equal(await waitFor(() => calls.length >= 1), true);
    assert.equal(calls[0].plugins, 1);
  } finally {
    stop();
  }
});

test("translates the actual installed cache manifest", async () => {
  writeManifest("Code intelligence and review");
  const result = await syncWithTranslation({
    autoTranslate: true,
    translator: fakeTranslator,
    forceTranslate: true,
    quiet: true,
    allowAppServer: false,
    allowCli: false,
    lockWaitMs: 10000,
  });

  assert.equal(result.translation.translated, 3);
  assert.equal(result.pending.length, 0);
  const iface = manifestInterface();
  assert.equal(iface.displayName, "中:displayName");
  assert.equal(iface.shortDescription, "中:shortDescription");
  assert.equal(iface.longDescription, "中:longDescription");
  const entry = loadState().plugins["remote-market/qodo"];
  assert.equal(entry.manifestPath, manifestPath);
  assert.ok(entry.lastAppliedAt);
});

test("restores the original English in the installed cache manifest", async () => {
  const result = await restoreOriginals({
    force: true,
    quiet: true,
    lockWaitMs: 10000,
  });
  assert.equal(result.errors.length, 0);
  const iface = manifestInterface();
  assert.equal(iface.displayName, "Qodo");
  assert.equal(iface.shortDescription, "Code intelligence and review");
  assert.equal(
    iface.longDescription,
    "Qodo setup, code intelligence, and review workflows.",
  );
});

test("cleans up the installed cache fixture", () => {
  fs.rmSync(root, { recursive: true, force: true });
});
