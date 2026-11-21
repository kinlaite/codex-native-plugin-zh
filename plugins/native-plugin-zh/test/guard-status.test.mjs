import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-guard-status-"));
const codexHome = path.join(root, "codex-home");
const configFile = path.join(codexHome, "config.toml");
const guardCache = path.join(
  codexHome,
  "plugins",
  "cache",
  "test-mp",
  "native-plugin-zh-guard",
  "1.2.0",
);
fs.mkdirSync(guardCache, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
process.env.CODEX_HOME = codexHome;
process.env.CODEX_PLUGIN_ZH_DATA_DIR = path.join(codexHome, "plugin-i18n-native");
process.env.CODEX_PLUGIN_ZH_MARKETPLACE = "test-mp";
process.env.USERPROFILE = root;
process.env.HOME = root;

const { inspectGuardStatus } = await import("../lib/maintenance.mjs");

function writeConfig(enabled) {
  fs.writeFileSync(
    configFile,
    [
      '[plugins."native-plugin-zh-guard@test-mp"]',
      `enabled = ${enabled}`,
      "",
      '[hooks.state."native-plugin-zh-guard@test-mp:hooks/hooks.json:session_start:0:0"]',
      'trusted_hash = "test-hash"',
      "",
    ].join("\n"),
    "utf8",
  );
}

test("detects an installed and enabled guard plugin", () => {
  writeConfig(true);
  const result = inspectGuardStatus();
  assert.equal(result.marketplace, "test-mp");
  assert.equal(result.pluginId, "native-plugin-zh-guard@test-mp");
  assert.equal(result.installed, true);
  assert.equal(result.enabled, true);
  assert.equal(result.hookTrust.configured, true);
  assert.equal(result.installCommand, "codex plugin add native-plugin-zh-guard@test-mp");
});

test("reports a disabled guard plugin", () => {
  writeConfig(false);
  const result = inspectGuardStatus();
  assert.equal(result.installed, true);
  assert.equal(result.enabled, false);
});

test("cleans up guard status fixture", () => {
  fs.rmSync(root, { recursive: true, force: true });
});
