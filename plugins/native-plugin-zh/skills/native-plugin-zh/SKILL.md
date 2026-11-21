---
name: native-plugin-zh
description: Use when the user wants Chinese names and descriptions directly inside the native Codex plugin UI, asks to check or repair native plugin localization, restores English, or needs the localization to follow a plugin enable/disable lifecycle safely.
---

# Codex 原生插件中文化

使用 `native_zh_*` MCP 工具维护 Codex 原生插件页面的中文清单覆盖层。权威状态和翻译位于 `~/.codex/plugin-i18n-native`；可执行代码只来自 Codex 管理的插件缓存，不维护第二份稳定运行目录。英文恢复由独立插件 `native-plugin-zh-guard` 在 `SessionStart` 完成，主插件关闭后不会执行自己的 hooks。

## 生命周期

- 插件启用并重启 Codex：`SessionStart` 或 MCP 启动，从缓存写入中文。
- 插件关闭并重启 Codex：恢复守护插件在 `SessionStart` 恢复英文，同时保留中文化偏好、翻译缓存和备份。
- 在插件仍启用时手动恢复：暂停中文化；普通重启不写入，只有再次调用 `native_zh_apply` 或先关闭再重新启用插件才会恢复。
- 主插件与恢复守护插件必须一起安装、一起保持启用；两者的 hooks 首次使用都需要用户批准。插件内容变化后 Codex 可能再次要求批准。

## 常用流程

1. 用户要求检查状态或更新后页面变回英文时，先调用 `native_zh_diagnose`。
2. 有中文待写入时调用 `native_zh_apply`；它只使用已有缓存。
3. 有 `pending` 字段时调用 `native_zh_sync` 并允许自动翻译；只处理新增或英文发生变化的字段。
4. 用户要求恢复英文时调用 `native_zh_restore`。
5. 用户要关闭插件时，提醒其关闭主插件后重启 Codex，由恢复守护插件恢复英文；如果 `native_zh_diagnose` 显示守护未安装或未启用，先让用户安装/启用 `native-plugin-zh-guard`。

## 规则

- 不安装计划任务，不创建稳定运行目录，不启动常驻后台进程，不依赖外部同步器。
- 不把 `SessionEnd` 当成可靠恢复机制：Codex 禁用插件后会移除该插件的 hooks 和 MCP。
- 升级启动时自动清理旧版计划任务、`tool` 目录、`task.xml` 和相关设置字段。
- 只通过 MCP 工具或插件自带 CLI 操作，不手动改 `app.asar`、WindowsApps 安装目录或 `~/.codex/plugins/cache`。
- 目标来源清单必须是 Codex 实际发现的 marketplace 源路径；安装缓存不是生效来源。
- 原中文源文本不要送翻译；工具会自动跳过含汉字的字段。
- 翻译缓存以插件 ID、字段和源文本 SHA-256 为键；源文本没变时复用旧译文。
- 最后提醒用户：插件页面若已打开，点击刷新即可看到写入结果。
- 如果用户报告 Codex 崩溃、强制结束或 hooks 未批准导致仍是中文，使用已安装版本的 `scripts/cli.mjs restore` 做应急恢复。
- 状态文件损坏时，恢复流程会结合 `backups` 和翻译缓存，只回写仍等于缓存译文的字段；备份使用源英文重建，不会保存正在生效的中文。
- 恢复会跳过用户编辑和已删除字段。`uninstall --purge` 在恢复被跳过、存在冲突或错误时拒绝删除备份。
- 旧版手动暂停偏好会保留；旧计划任务删除失败时会在下一次启动继续重试。
- 这是非官方、可恢复的本地覆盖层。明确区分“已实现的更新自恢复”与“未来协议彻底变化时无法绝对保证”。
