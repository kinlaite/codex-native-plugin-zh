# 原生插件中文化（native-plugin-zh）

在 **Windows 版 Codex 桌面应用**的插件市场、已安装列表和详情页中显示简体中文名称、简介与详细说明。

单插件自闭环：启用后写入中文，关闭后恢复英文；Codex 更新、目标插件更新或新装本地插件后自动增量翻译；切换开关可自动重启 Codex，独立重启助手不会显示命令行黑色窗口。

## 系统要求

- Windows 10 或 Windows 11。
- 支持插件与 hooks 的 Codex 桌面版。
- Codex 自带的 Node 运行时，或 PATH 中可用的 Node.js 20+。
- 自动重启依赖 Windows WMI；WMI 受限时会退化为普通隐藏进程，仍可用 `autoRestartApp: false` 改为手动重启。

非 Windows 平台不受支持。

## 安装

### 从 GitHub

当前 `main` 发布版本为 **1.6.0**：

```powershell
codex plugin marketplace add kinlaite/codex-native-plugin-zh --ref main
codex plugin add native-plugin-zh@native-plugin-zh-local
```

### 从本地 marketplace

解压发布包后，把命令中的路径替换为包含 `.agents\plugins\marketplace.json` 的目录：

```powershell
codex plugin marketplace add C:\path\to\marketplace
codex plugin add native-plugin-zh@native-plugin-zh-local
```

用下面的命令核对版本：

```powershell
codex plugin list --available --json
```

安装后启用插件、批准 hooks，并重启一次 Codex。

## 生命周期

- **自动重启**：监听器先写对清单，再通过 WMI 创建使用 `DETACHED_PROCESS` 的 Node 助手。助手不分配控制台窗口，独立于 Codex 进程树，能完成“关闭 → 重新拉起”。可在 `~/.codex/plugin-i18n-native/settings.json` 设置 `"autoRestartApp": false`。
- **启用**：hooks 或插件 MCP 启动时把缓存译文写入 Codex 实际读取的插件清单。
- **自动增量翻译**：MCP 启动后会监听本地插件清单。Codex 更新重新物化 marketplace、目标插件升级、新装本地插件、清单路径或内容变化，都会触发一次增量同步；英文未变字段复用缓存，只调用 Codex 翻译新增或英文变化的字段。
- **关闭**：以下任一路径都会恢复英文：
  1. `~/.codex/config.toml` 中注册的用户级恢复 MCP，Codex 每次启动都会拉起；
  2. 运行中的插件 MCP 监听 `config.toml` 变化；
  3. `SessionEnd` 检查；
  4. MCP 进程被回收前的最后一次检查。
- **手动恢复**：`native_zh_restore` 恢复英文并暂停中文化；再次 `native_zh_apply` 或关闭后重新启用插件可恢复中文。
- **卸载**：`native_zh_uninstall` 先恢复英文，再移除用户级恢复 MCP；`--purge` 同时删除运行数据。

为什么需要用户级恢复 MCP：Codex 禁用插件时会移除其 hooks/MCP 装配，并可能立即结束插件进程。“恢复 MCP”不属于任何插件，因此能在插件关闭后继续兜底，它不是第二个插件。

## 自动更新检测

- 清单指纹包含插件 key、清单路径、版本、修改时间、大小和内容 SHA-256。即使插件更新保留了旧时间戳，只要英文内容变化也会被发现。
- 默认每 15 秒轮询一次，检测到变化后去抖 2.5 秒再同步；可用 `catalogPollMs` 和 `catalogDebounceMs` 调整。
- MCP 启动时若发现待翻译字段，会在约 2 秒后后台处理，不阻塞 Codex 启动。
- 待翻译字段在没有失败时会每 5 分钟重试一次；翻译失败后进入 15 分钟退避，期间不再调用模型。
- 设置 `"autoTranslate": false` 可关闭自动翻译，但仍会同步已有缓存；`native_zh_sync` 可随时立即触发。

`~/.codex/plugin-i18n-native/settings.json` 示例：

```json
{
  "autoTranslate": true,
  "autoRestartApp": true,
  "catalogPollMs": 15000,
  "catalogDebounceMs": 2500
}
```

## 数据与隐私

- 会改写 Codex 实际读取的本地插件清单，并在 `.codex\plugin-i18n-native\backups` 保存英文原值备份。
- 启用时会在 `config.toml` 注册 `[mcp_servers.native_plugin_zh_restore]`；卸载工具会移除。
- 状态、译文、备份和日志保存在 `~/.codex/plugin-i18n-native`，不写入插件安装缓存。
- 调用需要翻译的同步操作时，新增或变化的英文字段会通过用户当前配置的 Codex 模型处理；后台自动翻译也可能消耗模型额度。插件本身不连接第三方翻译服务。
- 不修改 Codex 本体、`app.asar`、WindowsApps 或插件安装缓存。

## 正确性保障

- 恢复以备份的英文原值为唯一权威；清单中的中文覆盖会被还原。
- 只有既不是英文原值、也不是源文本的非中文改动才视为用户编辑并保留。
- 原本不存在的字段在恢复时删除；用户主动删除的字段不会被重新创建。
- 写入前保存完整清单备份；源文本以 SHA-256 关联译文，英文变化后不会误用旧缓存。
- 后台同步使用同一套系统锁和源文本哈希；多进程同时启动监听器时会自动去重。
- 所有写操作使用系统级互斥，异常退出的进程不会永久占用锁。
- `uninstall --purge` 在恢复被跳过、存在冲突或错误时拒绝删除备份。

## 安全边界

- 自动重启只处理本机 `ChatGPT.exe`，不结束其他应用。
- 同一开关状态的重复触发有 45 秒冷却；启用与关闭方向互不阻塞。
- 不安装计划任务，不修改 `app.asar` 或 WindowsApps。
- 不写死用户名、盘符或 Node 路径；`CODEX_HOME`、用户目录和 Codex/Node 位置在运行时解析。

## 已知限制

- 依赖 Codex 当前的插件清单、hooks 和用户级 MCP 协议；协议彻底变化后需要适配。
- 只覆盖 `displayName`、`shortDescription`、`longDescription` 三个字段；分类、开发者名、默认提示词和截图不翻译。
- hooks 未批准、文件只读或锁争用极端严重时，自动写入可能失败；可运行已安装版本的 `scripts/cli.mjs restore`，或调用 `native_zh_restore_check`。
- 远端 Git marketplace 中的插件不能通过本地清单覆盖；本插件只处理本地可见的插件源。
- Codex 更新重新物化内置 marketplace 后，后台监听或下一次启动会自动修复；若更新期间应用未运行，则由下次启动处理。
- 这是非官方、可恢复的本地覆盖层，不代表 OpenAI 官方本地化。
