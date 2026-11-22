---
name: native-plugin-zh
description: Use when the user wants Chinese names and descriptions directly inside the native Codex plugin UI, asks to check or repair native plugin localization, restores English, or needs the localization to follow a plugin enable/disable lifecycle safely.
---

# Codex 原生插件中文化

使用 `native_zh_*` MCP 工具维护 Windows 版 Codex 原生插件页面的中文清单覆盖层。权威状态和翻译位于 `~/.codex/plugin-i18n-native`；插件代码由 Codex 缓存管理，自包含恢复脚本同步到数据目录下的 `bin`。**单插件自闭环，不依赖其他插件**：启用写中文，关闭自动恢复英文。

## 生命周期

- 切换插件开关后自动重启 Codex：监听器先把清单写对（启用 → 中文，关闭 → 英文），再通过 WMI 以 `DETACHED_PROCESS` 派生 Node 助手关闭并重新拉起 Codex；助手独立于 Codex 进程树且不显示控制台窗口。`settings.json` 的 `autoRestartApp: false` 可关闭自动重启。
- 插件启用：`SessionStart` 或 MCP 启动，从缓存写入中文；同时把自包含恢复脚本同步到 `~/.codex/plugin-i18n-native/bin`，并确保 `config.toml` 中 `[mcp_servers.native_plugin_zh_restore]` 注册存在。
- 自动增量翻译：MCP 启动后轮询本地 marketplace 源和 Git 插件的已安装缓存清单（默认 15 秒，去抖 2.5 秒）。Codex 更新、目标插件更新、新装本地/Git 插件或清单内容变化时，只翻译新增和英文变化的字段。清单指纹包含路径、版本、mtime、大小和内容 SHA-256；待翻译字段每 5 分钟重试，失败后 15 分钟退避。`settings.json` 的 `autoTranslate: false` 可关闭自动翻译。
- 插件关闭：四层自动恢复，任一命中即可——
  1. **用户级恢复服务器**（根本保障，不随插件启停）：Codex 每次启动拉起它，开关关闭 → 恢复英文；开关启用 → 不做任何事；
  2. 运行中的 MCP 服务器监听 `config.toml`（`fs.watch` + 轮询），开关变化数秒内恢复英文；
  3. `SessionEnd` 检查；
  4. 进程被回收前的最后一次检查。
- 在插件仍启用时手动恢复（`native_zh_restore`）：暂停中文化；普通重启不写入，只有再次调用 `native_zh_apply` 或先关闭再重新启用插件才会恢复。
- 卸载：`native_zh_uninstall` 恢复英文并移除恢复服务器注册；`--purge` 同时删除数据目录。
- 应急：用已安装版本的 `scripts/cli.mjs restore`，或手动删除 config.toml 中的恢复服务器注册段落。

## 常用流程

1. 用户要求检查状态或更新后页面变回英文时，先调用 `native_zh_diagnose`。
2. 有中文待写入时调用 `native_zh_apply`；它只使用已有缓存。
3. 有 `pending` 字段时通常等待后台自动翻译即可；需要立即处理或诊断时调用 `native_zh_sync`。它只处理新增或英文发生变化的字段。
4. 用户要求恢复英文时调用 `native_zh_restore`。
5. 用户要关闭插件时，告知：关闭后由运行中的服务器自动恢复英文，并自动重启 Codex；重启后显示英文，无需任何配套插件。若已关闭自动重启，则提示手动重启。

## 规则

- 不安装计划任务，不依赖外部同步器或其他插件。恢复服务器是 `config.toml` 中的用户级 MCP 服务器，由 Codex 自己拉起；自包含脚本放在 `~/.codex/plugin-i18n-native/bin`，不随插件版本目录变化。
- 仅支持 Windows 10/11 的 Codex 桌面版；自动重启依赖 WMI，降级仍使用隐藏窗口。
- 安装前确认 marketplace 中显示版本 `1.6.1` 或更高；远程仓库落后时使用本地 marketplace 安装。
- 不把 `SessionEnd` 当成唯一恢复机制：监听器（MCP 进程内）和进程回收前的最后检查才是主要恢复路径，`SessionEnd` 只是兜底。
- 升级启动时自动清理旧版计划任务、`tool` 目录、`task.xml` 和相关设置字段。
- 只通过 MCP 工具或插件自带 CLI 操作，不手动改 `app.asar`、WindowsApps 安装目录或 `~/.codex/plugins/cache`；Git 插件缓存由插件按备份和源哈希流程自动维护。
- 本地 marketplace 插件写入 Codex 实际发现的源清单；Git/Git-subdir 插件没有本地源，写入 Codex 物化后的已安装缓存清单。
- 原中文源文本不要送翻译；工具会自动跳过含汉字的字段（中文源插件直接沿用原文）。
- 清单中残留的任何中文一律在恢复时回到英文原值，绝不当作用户编辑跳过；只有非中文的外部改动才保留。
- 翻译缓存以插件 ID、字段和源文本 SHA-256 为键；源文本没变时复用旧译文。
- 后台自动翻译默认开启；关闭后仍会写入已有缓存。`catalogPollMs`、`catalogDebounceMs` 可调整监听，修改 `settings.json` 后无需重装插件。
- 只覆盖 `displayName`、`shortDescription`、`longDescription`；不要把分类、开发者名、默认提示词或截图列入承诺范围。
- 最后提醒用户：插件页面若已打开，点击刷新即可看到写入结果。
- 状态文件损坏时，恢复流程会结合 `backups` 和翻译缓存重建字段；备份使用源英文重建，不会保存正在生效的中文。
- `uninstall --purge` 在恢复被跳过、存在冲突或错误时拒绝删除备份。
- 这是非官方、可恢复的本地覆盖层。明确区分“已实现的更新自恢复”与“未来协议彻底变化时无法绝对保证”。
