import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-auto-translate-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(codexHome, "plugin-i18n-native");
const marketplaceRoot = path.join(root, "marketplace");
const pluginRoot = path.join(marketplaceRoot, "plugins", "audit-target");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(
  path.join(codexHome, "config.toml"),
  [
    '[plugins."native-plugin-zh@native-plugin-zh-local"]',
    "enabled = true",
    "",
    "[marketplaces.audit-market]",
    'source_type = "local"',
    `source = '${marketplaceRoot.replaceAll("\\", "/")}'`,
    "",
  ].join("\n"),
  "utf8",
);
fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      name: "audit-target",
      interface: {
        displayName: "Audit Target",
        shortDescription: "Automatically translate changed fields",
        longDescription: "This manifest is used to verify background translation.",
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.env.CODEX_HOME = codexHome;
process.env.CODEX_PLUGIN_ZH_DATA_DIR = dataDir;
process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP = "1";
process.env.USERPROFILE = root;
process.env.HOME = root;

const { PACK_FILE } = await import("../lib/paths.mjs");
const { syncWithTranslation } = await import("../lib/sync.mjs");
const { autoTranslatePending } = await import("../lib/catalog.mjs");

function manifestInterface() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")).interface;
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

test("autoTranslate incrementally translates pending fields and applies them", async () => {
  const result = await syncWithTranslation({
    autoTranslate: true,
    translator: fakeTranslator,
    forceTranslate: true,
    quiet: true,
    allowAppServer: false,
    allowCli: false,
    lockWaitMs: 10000,
  });
  assert.equal(result.translation.attempted, 3);
  assert.equal(result.translation.translated, 3);
  assert.equal(result.pending.length, 0);
  const iface = manifestInterface();
  assert.equal(iface.displayName, "中:displayName");
  assert.equal(iface.shortDescription, "中:shortDescription");
  assert.equal(iface.longDescription, "中:longDescription");
});

test("autoTranslate false leaves new fields pending", async () => {
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        name: "audit-target",
        interface: {
          displayName: "Audit Target",
          shortDescription: "A second source change",
          longDescription: "This field is still untranslated.",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  let called = false;
  const result = await syncWithTranslation({
    autoTranslate: false,
    translator: async () => {
      called = true;
      return { attempted: 0, translated: 0, failed: 0 };
    },
    forceTranslate: true,
    quiet: true,
    allowAppServer: false,
    allowCli: false,
    lockWaitMs: 10000,
  });
  assert.equal(called, false);
  assert.ok(result.pending.some((item) => item.field === "shortDescription"));
  assert.equal(manifestInterface().shortDescription, "A second source change");
});

test("autoTranslatePending handles the startup pass and records catalog state", async () => {
  const result = await autoTranslatePending({
    reason: "startup-pending",
    translator: fakeTranslator,
    lockWaitMs: 10000,
  });
  assert.equal(result.translation.translated, 2);
  assert.equal(result.pending.length, 0);
  assert.equal(manifestInterface().displayName, "中:displayName");
  assert.equal(manifestInterface().shortDescription, "中:shortDescription");
  assert.equal(manifestInterface().longDescription, "中:longDescription");
  const catalogState = JSON.parse(
    fs.readFileSync(path.join(dataDir, "catalog-state.json"), "utf8"),
  );
  assert.equal(catalogState.reason, "startup-pending");
  assert.equal(catalogState.pending, 0);
  assert.equal(catalogState.nextPendingRetryAt, null);
});

test("cleans up the auto translation fixture", () => {
  fs.rmSync(root, { recursive: true, force: true });
});
