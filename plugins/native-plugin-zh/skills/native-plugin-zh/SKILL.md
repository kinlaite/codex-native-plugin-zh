---
name: native-plugin-zh
description: Use when the user wants Chinese names and descriptions directly inside the native Codex plugin UI, asks to check or repair native plugin localization, restores English, or needs the localization to survive Codex or plugin updates. Also use after a Codex update when plugin cards revert to English.
---

# Codex 原生插件中文化

使用 `native_zh_*` MCP 工具维护 Codex 原生插件页面的中文 manifest 覆盖层。权威数据始终位于 `~/.codex/plugin-i18n-native`，不能在插件安装缓存或 `app.asar` 中维护。

## 常用流程

1. 用户要求检查状态或更新后页面变回英文时，先调用 `native_zh_diagnose`。
2. 有中文待写入时调用 `native_zh_apply`；它使用已有翻译缓存并立即写回来源清单。
3. 有 `pending` 字段时调用 `native_zh_sync` 并允许自动翻译；只处理新增或英文发生变化的字段。
4. 用户要求恢复英文时调用 `native_zh_restore`。默认只恢复仍等于缓存中文的字段，避免覆盖期间发生的插件更新。
5. 自动同步任务缺失或失效时调用 `native_zh_install_autosync`。

## 规则

- 只通过 MCP 工具操作，不手动改 `app.asar`、WindowsApps 安装目录或 `~/.codex/plugins/cache` 中的安装副本。
- 目标来源清单必须是 Codex 实际发现的 marketplace 源路径；安装缓存不是生效来源。
- 原中文源文本不要送翻译；工具会自动跳过含汉字的字段。
- 翻译缓存以插件 ID、字段和源文本 SHA-256 为键。源文本没变时复用旧译文。
- 最后提醒用户：原生插件页若已打开，点击页面“刷新”即可看到写入结果，通常不需要重启 Codex。
- 这是非官方、可恢复的本地覆盖层。明确区分“已实现的更新自恢复”与“上游彻底改变协议时无法绝对保证”。
