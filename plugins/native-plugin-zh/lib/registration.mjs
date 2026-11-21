// config.toml 中用户级恢复服务器的注册管理。
//
// 这是“关闭插件后恢复英文”的根本保障：插件被禁用后其 hooks/MCP 不会再被
// Codex 装配（实测进程还会被硬杀），必须有一个不随插件启停的入口在每次
// Codex 启动时检查并恢复英文。它不是第二个插件——只是 config.toml 里一条
// 用户级 MCP 服务器配置，指向插件数据目录中的自包含恢复脚本。
// 插件启用时该服务器不做任何事；卸载流程会移除这条配置。
import fs from "node:fs";
import path from "node:path";

import { CONFIG_FILE, DATA_DIR, PLUGIN_DIR, logLine, writeTextAtomic } from "./paths.mjs";

export const RESTORE_SERVER_ID = "native_plugin_zh_restore";
const HEADER_RE = /^\s*\[\s*mcp_servers\.native_plugin_zh_restore(?:\.[^\]]+)?\]\s*$/;

function launcherPath() {
  return path.join(DATA_DIR, "bin", "launch-restore.cmd");
}

function sectionBlock() {
  const launcher = launcherPath();
  return [
    `[mcp_servers.${RESTORE_SERVER_ID}]`,
    `# 原生插件中文化：独立于插件启停状态的英文恢复兜底（插件启用时它不做任何事）。`,
    `command = 'cmd.exe'`,
    `args = ['/d', '/s', '/c', 'call', '${launcher}']`,
    `startup_timeout_sec = 20`,
    ``,
  ].join("\n");
}

function readConfigText() {
  try {
    return fs.readFileSync(CONFIG_FILE, "utf8");
  } catch {
    return null;
  }
}

// 复制自包含恢复脚本到数据目录，路径不随插件版本目录变化。
export function syncRestoreServerBin() {
  const binDir = path.join(DATA_DIR, "bin");
  fs.mkdirSync(path.join(binDir, "lib"), { recursive: true });
  const copies = [
    [path.join(PLUGIN_DIR, "scripts", "launch-restore.cmd"), path.join(binDir, "launch-restore.cmd")],
  ];
  // bin 副本与其 lib 同级，导入路径从 ../lib/ 改写为 ./lib/
  const serverSource = fs.readFileSync(path.join(PLUGIN_DIR, "scripts", "restore-server.mjs"), "utf8");
  copies.push([
    null,
    path.join(binDir, "restore-server.mjs"),
    serverSource.replaceAll('from "../lib/', 'from "./lib/'),
  ]);
  const libDir = path.join(PLUGIN_DIR, "lib");
  try {
    for (const name of fs.readdirSync(libDir)) {
      if (name.endsWith(".mjs")) {
        copies.push([path.join(libDir, name), path.join(binDir, "lib", name)]);
      }
    }
  } catch {}
  copies.push([
    path.join(PLUGIN_DIR, "scripts", "restart-app.mjs"),
    path.join(binDir, "restart-app.mjs"),
  ]);
  for (const [from, to, override] of copies) {
    try {
      let content;
      if (override !== undefined) {
        content = Buffer.from(override, "utf8");
      } else {
        content = fs.readFileSync(from);
      }
      // cmd.exe 解析 LF-only 批处理会出错；.cmd 一律规范化为 CRLF。
      if (to.endsWith(".cmd")) {
        content = Buffer.from(content.toString("utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"), "utf8");
      }
      try {
        if (fs.readFileSync(to).equals(content)) continue;
      } catch {}
      fs.writeFileSync(to, content);
    } catch (error) {
      logLine(`同步恢复脚本失败 ${path.basename(to)}：${error.message}`);
      return false;
    }
  }
  try {
    fs.rmSync(path.join(binDir, "restart-app.ps1"), { force: true });
  } catch {}
  return true;
}

function sectionIndexes(lines) {
  const spans = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (HEADER_RE.test(lines[i])) {
      if (current) spans.push(current);
      current = { start: i };
      continue;
    }
    if (current && /^\s*\[/.test(lines[i])) {
      spans.push({ start: current.start, end: i - 1 });
      current = null;
    }
  }
  if (current) spans.push({ start: current.start, end: lines.length - 1 });
  return spans;
}

function registeredLauncherPath(lines) {
  for (const span of sectionIndexes(lines)) {
    for (let i = span.start; i <= span.end; i += 1) {
      if (!lines[i].includes("launch-restore.cmd")) continue;
      // args = ['/d', '/s', '/c', 'call', '<launcher>'] —— 取该行最后一个引号 token
      const tokens = [...lines[i].matchAll(/'([^']+)'/g)].map((match) => match[1]);
      if (tokens.length) return tokens[tokens.length - 1];
    }
  }
  return null;
}

export function ensureRestoreServerRegistered() {
  const text = readConfigText();
  if (text === null) return { registered: false, reason: "config-unreadable" };
  const expected = launcherPath();
  let lines = text.split(/\r?\n/);
  const spans = sectionIndexes(lines);
  if (spans.length > 0) {
    const current = registeredLauncherPath(lines);
    if (current && path.resolve(current) === path.resolve(expected)) {
      return { registered: true, changed: false };
    }
    // 路径过期（数据目录移动等）：整段替换
    lines = lines.filter((line, index) => {
      for (const span of spans) {
        if (index >= span.start && index <= span.end) return false;
      }
      return true;
    });
  }
  let body = lines.join("\n");
  if (body.trim().length && !body.endsWith("\n")) body += "\n";
  body += `\n${sectionBlock()}`;
  try {
    writeTextAtomic(CONFIG_FILE, body);
  } catch (error) {
    logLine(`写入恢复服务器注册失败：${error.message}`);
    return { registered: false, reason: "config-write-failed" };
  }
  logLine(`恢复服务器已注册：[mcp_servers.${RESTORE_SERVER_ID}] -> ${expected}`);
  return { registered: true, changed: true, launcher: expected };
}

export function removeRestoreServerRegistration() {
  const text = readConfigText();
  if (text === null) return { removed: false, reason: "config-unreadable" };
  const lines = text.split(/\r?\n/);
  const spans = sectionIndexes(lines);
  if (!spans.length) return { removed: false, reason: "not-registered" };
  const kept = lines.filter((line, index) => {
    for (const span of spans) {
      if (index >= span.start && index <= span.end) return false;
    }
    return true;
  });
  let body = kept.join("\n").replace(/\n{3,}$/, "\n");
  if (body.trim().length && !body.endsWith("\n")) body += "\n";
  try {
    writeTextAtomic(CONFIG_FILE, body);
  } catch (error) {
    logLine(`移除恢复服务器注册失败：${error.message}`);
    return { removed: false, reason: "config-write-failed" };
  }
  logLine(`恢复服务器注册已移除：[mcp_servers.${RESTORE_SERVER_ID}]`);
  return { removed: true };
}
