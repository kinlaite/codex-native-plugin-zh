import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceRoot = path.resolve(root, "..", "..");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertBundledPath(relative, label) {
  assert.match(relative, /^\.\//, `${label} 必须以 ./ 开头`);
  const resolved = path.resolve(root, relative);
  assert.equal(
    resolved.startsWith(`${root}${path.sep}`),
    true,
    `${label} 不能逃逸插件根目录`,
  );
  assert.equal(fs.existsSync(resolved), true, `${label} 指向的文件不存在：${relative}`);
  return resolved;
}

test("plugin manifests use a consistent version and valid resource paths", () => {
  const plugin = readJson(path.join(root, ".codex-plugin", "plugin.json"));
  const packageJson = readJson(path.join(root, "package.json"));
  const pathsSource = fs.readFileSync(path.join(root, "lib", "paths.mjs"), "utf8");
  const sourceVersion = pathsSource.match(/APP_VERSION = "([^"]+)"/)?.[1];

  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(plugin.version, packageJson.version);
  assert.equal(plugin.version, sourceVersion);
  assert.match(plugin.name, /^[a-z0-9][a-z0-9.-]*$/);
  assert.equal(plugin.license, "MIT");
  assert.equal(fs.existsSync(path.join(root, "LICENSE")), true);

  assert.equal(plugin.skills, "./skills/");
  assertBundledPath(plugin.skills, "skills");
  assertBundledPath(plugin.hooks, "hooks");
  assertBundledPath(plugin.mcpServers, "mcpServers");
  assertBundledPath(plugin.interface.composerIcon, "interface.composerIcon");
  assertBundledPath(plugin.interface.logo, "interface.logo");

  const prompts = plugin.interface.defaultPrompt;
  assert.ok(Array.isArray(prompts));
  assert.ok(prompts.length <= 3);
  for (const prompt of prompts) {
    assert.ok(prompt.trim().length > 0);
    assert.ok(prompt.length <= 512);
  }
  assert.match(plugin.interface.brandColor, /^#[0-9a-f]{6}$/i);
  assert.match(plugin.interface.websiteUrl, /^https:\/\//);
});

test("MCP and hooks files match the current Codex plugin format", () => {
  const plugin = readJson(path.join(root, ".codex-plugin", "plugin.json"));
  const mcp = readJson(path.join(root, plugin.mcpServers));
  const server = mcp.mcpServers?.native_plugin_zh;
  assert.ok(server, "缺少 native_plugin_zh MCP 服务");
  assert.equal(typeof server.command, "string");
  assert.ok(Array.isArray(server.args));
  const launcher = server.args.at(-2);
  assertBundledPath(launcher, "MCP launcher");
  assert.equal(fs.existsSync(path.join(root, "server.mjs")), true);

  const hooks = readJson(path.join(root, plugin.hooks));
  const knownEvents = new Set([
    "PreModelRequest",
    "PostModelRequest",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "Interrupt",
  ]);
  for (const event of Object.keys(hooks.hooks || {})) {
    assert.equal(knownEvents.has(event), true, `未知 hook 事件：${event}`);
  }
  for (const event of ["SessionStart", "SessionEnd"]) {
    const handler = hooks.hooks?.[event]?.[0]?.hooks?.[0];
    assert.equal(handler?.type, "command", `${event} 应使用 command hook`);
    assert.match(handler.command, /\$\{PLUGIN_ROOT\}/);
    assert.ok(handler.timeout > 0);
  }
});

test("marketplace entry resolves to this plugin", () => {
  const manifestPath = path.join(
    marketplaceRoot,
    ".agents",
    "plugins",
    "marketplace.json",
  );
  if (!fs.existsSync(manifestPath)) {
    return;
  }
  const marketplace = readJson(manifestPath);
  const entry = marketplace.plugins?.find((plugin) => plugin.name === "native-plugin-zh");
  assert.ok(entry, "marketplace 中缺少 native-plugin-zh");
  assert.equal(entry.source?.source, "local");
  assert.match(entry.source?.path, /^\.\//);
  assert.equal(
    path.resolve(marketplaceRoot, entry.source.path),
    root,
    "marketplace source.path 必须指向插件根目录",
  );
});

test("shipped code has no machine-specific absolute paths", () => {
  const forbidden = [
    /C:\\Users\\/i,
    /C:\/Users\//i,
    /Documents\\Codex\\/i,
    /\/home\/[^/]+\//i,
  ];
  const extensions = new Set([".mjs", ".json", ".cmd", ".md", ".svg"]);
  const ignored = new Set(["test", "translations", "assets"]);

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !extensions.has(path.extname(entry.name))) continue;
    const content = fs.readFileSync(path.join(root, entry.name), "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(content, pattern, `${entry.name} 含本机绝对路径`);
    }
  }

  for (const directory of ["lib", "scripts", "hooks"]) {
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!ignored.has(entry.name)) walk(file);
          continue;
        }
        if (!extensions.has(path.extname(entry.name))) continue;
        const content = fs.readFileSync(file, "utf8");
        for (const pattern of forbidden) {
          assert.doesNotMatch(content, pattern, `${path.relative(root, file)} 含本机绝对路径`);
        }
      }
    };
    walk(path.join(root, directory));
  }
});
