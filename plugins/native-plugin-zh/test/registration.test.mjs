import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-registration-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(codexHome, "plugin-i18n-native");
fs.mkdirSync(dataDir, { recursive: true });
process.env.CODEX_HOME = codexHome;
process.env.CODEX_PLUGIN_ZH_DATA_DIR = dataDir;
process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP = "1";
process.env.USERPROFILE = root;
process.env.HOME = root;

const configPath = path.join(codexHome, "config.toml");
const { ensureRestoreServerRegistered, removeRestoreServerRegistration, syncRestoreServerBin } =
  await import("../lib/registration.mjs");

fs.writeFileSync(
  configPath,
  `# Codex CLI 配置\n\n[mcp_servers.other]\ncommand = 'node.exe'\nargs = ['x.mjs']\n`,
  "utf8",
);

function readConfig() {
  return fs.readFileSync(configPath, "utf8");
}

test("syncs self-contained restore scripts into the data dir", () => {
  assert.equal(syncRestoreServerBin(), true);
  const binDir = path.join(dataDir, "bin");
  for (const relative of [
    "restore-server.mjs",
    "launch-restore.cmd",
    path.join("lib", "paths.mjs"),
    path.join("lib", "sync.mjs"),
  ]) {
    assert.equal(fs.existsSync(path.join(binDir, relative)), true, relative);
  }
});

test("registers the restore server once and stays idempotent", () => {
  const first = ensureRestoreServerRegistered();
  assert.equal(first.registered, true);
  assert.equal(first.changed, true);
  let text = readConfig();
  assert.match(text, /\[mcp_servers\.native_plugin_zh_restore\]/);
  assert.match(text, /launch-restore\.cmd/);
  assert.match(text, /\[mcp_servers\.other\]/);

  const second = ensureRestoreServerRegistered();
  assert.equal(second.registered, true);
  assert.equal(second.changed, false);
  assert.equal(readConfig(), text);
});

test("rewrites stale launcher paths", () => {
  fs.writeFileSync(
    configPath,
    readConfig().replace(
      /call', '[^']*launch-restore\.cmd'/,
      "call', 'C:\\stale\\launch-restore.cmd'",
    ),
    "utf8",
  );
  const result = ensureRestoreServerRegistered();
  assert.equal(result.registered, true);
  assert.equal(result.changed, true);
  assert.match(readConfig(), new RegExp(result.launcher.replace(/\\/g, "\\\\")));
});

test("removes the registration cleanly", () => {
  assert.equal(removeRestoreServerRegistration().removed, true);
  const text = readConfig();
  assert.doesNotMatch(text, /native_plugin_zh_restore/);
  assert.match(text, /\[mcp_servers\.other\]/);
  const again = removeRestoreServerRegistration();
  assert.equal(again.removed, false);
  assert.equal(again.reason, "not-registered");
});
