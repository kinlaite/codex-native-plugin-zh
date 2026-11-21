import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-zh-migration-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(codexHome, "plugin-i18n-native");
process.env.CODEX_HOME = codexHome;
process.env.CODEX_PLUGIN_ZH_DATA_DIR = dataDir;
process.env.CODEX_PLUGIN_ZH_DISABLE_BOOTSTRAP = "1";

const { cleanupLegacyResidue } = await import("../lib/migration.mjs");

fs.mkdirSync(path.join(dataDir, "tool", "scripts"), { recursive: true });
fs.writeFileSync(path.join(dataDir, "tool", "scripts", "cli.mjs"), "legacy\n", "utf8");
fs.writeFileSync(path.join(dataDir, "task.xml"), "<Task />\n", "utf8");
fs.writeFileSync(
  path.join(dataDir, "settings.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      codexBin: "C:\\Codex\\codex.exe",
      autoTranslate: true,
      runtimeSource: "legacy",
      runtimeTarget: path.join(dataDir, "tool"),
      runtimeVersion: "1.0.7",
      taskName: "CodexPluginZhNativeSync",
      taskAction: "powershell.exe -File legacy.ps1",
    },
    null,
    2,
  )}\n`,
  "utf8",
);

test("removes legacy task files, runtime directory, and settings fields", () => {
  const result = cleanupLegacyResidue({ removeTask: false });
  assert.equal(result.skipped, false);
  assert.equal(result.removedTool, true);
  assert.equal(result.removedTaskXml, true);
  assert.equal(fs.existsSync(path.join(dataDir, "tool")), false);
  assert.equal(fs.existsSync(path.join(dataDir, "task.xml")), false);
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
  assert.equal(settings.runtimeSource, undefined);
  assert.equal(settings.taskName, undefined);
  assert.equal(settings.codexBin, "C:\\Codex\\codex.exe");
  assert.equal(settings.autoTranslate, true);
});

test("legacy cleanup is idempotent", () => {
  const result = cleanupLegacyResidue({ removeTask: false });
  assert.equal(result.skipped, true);
});

test("cleans up the migration fixture", () => {
  fs.rmSync(root, { recursive: true, force: true });
});
