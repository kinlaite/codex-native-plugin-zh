import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-performance-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(codexHome, "plugin-i18n-native");
const marketplaceRoot = path.join(root, "marketplace");
const pluginsRoot = path.join(marketplaceRoot, "plugins");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(pluginsRoot, { recursive: true });
fs.writeFileSync(
  path.join(codexHome, "config.toml"),
  [
    '[plugins."native-plugin-zh@native-plugin-zh-local"]',
    "enabled = true",
    "",
    "[marketplaces.performance-local]",
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

const manifestPaths = [];
for (const name of ["alpha", "beta", "gamma"]) {
  const directory = path.join(pluginsRoot, name);
  fs.mkdirSync(path.join(directory, ".codex-plugin"), { recursive: true });
  const manifestPath = path.join(directory, ".codex-plugin", "plugin.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        name,
        version: "1.0.0",
        interface: {
          displayName: name,
          shortDescription: `${name} short description`,
          longDescription: `${name} long description`,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  manifestPaths.push(manifestPath);
}

const { catalogFingerprint } = await import("../lib/catalog.mjs");
const { discoverLocalPlugins } = await import("../lib/discovery.mjs");

test("catalog fingerprint reuses manifests read during discovery", async () => {
  const counts = new Map();
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function readFileSyncCounted(file, ...args) {
    if (typeof file === "string" && manifestPaths.includes(file)) {
      counts.set(file, (counts.get(file) || 0) + 1);
    }
    return originalReadFileSync.call(this, file, ...args);
  };
  try {
    const catalog = await catalogFingerprint({
      allowAppServer: false,
      allowCli: false,
    });
    assert.equal(catalog.plugins, 3);
    for (const manifestPath of manifestPaths) {
      assert.equal(
        counts.get(manifestPath),
        1,
        `${path.basename(path.dirname(path.dirname(manifestPath)))} 清单只应读取一次`,
      );
    }
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test("discovery exposes the manifest snapshot used by the fingerprint", async () => {
  const discovered = await discoverLocalPlugins({
    allowAppServer: false,
    allowCli: false,
  });
  assert.equal(discovered.plugins.length, 3);
  for (const plugin of discovered.plugins) {
    assert.equal(typeof plugin.manifestText, "string");
    assert.equal(typeof plugin.manifestStat.mtimeMs, "number");
    assert.equal(typeof plugin.manifestStat.size, "number");
    assert.equal(plugin.manifest.obj.name, plugin.pluginName);
  }
});

test("cleans up the performance fixture", () => {
  fs.rmSync(root, { recursive: true, force: true });
});
