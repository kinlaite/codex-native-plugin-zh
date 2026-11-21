# Codex 原生插件中文化

在 Codex 的原生插件市场、已安装列表和详情页中直接显示中文名称、简介与详细说明。

本项目是一个可恢复的本地插件清单覆盖层：

- 直接替换 Codex 实际读取的本地 marketplace 清单字段。
- 不修改 `app.asar`、WindowsApps 安装目录或插件安装缓存。
- 修改前保存完整原清单，可随时恢复英文。
- 翻译按插件 ID、字段和源文本 SHA-256 缓存。
- Codex 或目标插件更新后，自动命中原翻译并恢复中文。
- 仅需翻译新增或发生变化的英文内容。
- Windows 计划任务每 5 分钟检查一次，也可通过 MCP 工具手动同步。

> 非 OpenAI 官方项目。请先在测试环境确认符合你的使用需求。

## 功能

- 支持 `displayName`、`shortDescription` 和 `longDescription`。
- 支持 Codex app-server、`codex plugin marketplace list --json`、配置文件和已知目录扫描。
- 通过 Windows 命名管道提供系统级互斥，计划任务、MCP 和手工命令不会并发写入。
- 持锁进程异常退出后，锁由系统自动释放，不依赖锁龄清理。
- 状态、翻译缓存、备份和日志独立保存在 `~/.codex/plugin-i18n-native`。
- 插件自身升级不会覆盖翻译缓存和原清单备份。

## 要求

- Windows 10 或 Windows 11
- Codex 桌面版
- Codex 可用的 Node.js 20+

## 安装

```powershell
git clone https://github.com/kinlaite/codex-native-plugin-zh.git
cd codex-native-plugin-zh

codex plugin marketplace add .
codex plugin add native-plugin-zh@native-plugin-zh-local
```

安装完成后，在 Codex 的插件页面启用“原生插件中文化”，并重启一次 Codex，让 MCP 工具和技能加载。

## 使用

安装后会自动启用同步。若插件页面已经打开，刷新页面即可看到中文；必要时重启 Codex。

可用的 MCP 工具：

| 工具 | 用途 |
| --- | --- |
| `native_zh_status` | 查看中文化覆盖状态 |
| `native_zh_apply` | 立即写入已有中文翻译 |
| `native_zh_sync` | 重新发现插件并增量同步 |
| `native_zh_restore` | 恢复原始英文并暂停同步 |
| `native_zh_install_autosync` | 安装或修复计划任务 |
| `native_zh_uninstall_autosync` | 删除计划任务 |
| `native_zh_diagnose` | 检查运行目录、任务、Codex 和 Node 定位 |

## 恢复英文

让 Codex 调用 `native_zh_restore`，或者运行：

```powershell
node "$env:USERPROFILE\.codex\plugin-i18n-native\tool\scripts\cli.mjs" restore
```

恢复操作会暂停自动同步，但保留翻译缓存、状态和备份。重新启用中文：

```powershell
node "$env:USERPROFILE\.codex\plugin-i18n-native\tool\scripts\cli.mjs" apply
```

## 运行数据

| 内容 | 路径 |
| --- | --- |
| 权威状态 | `~/.codex/plugin-i18n-native/state.json` |
| 翻译缓存 | `~/.codex/plugin-i18n-native/translations.zh-CN.json` |
| 原清单备份 | `~/.codex/plugin-i18n-native/backups` |
| 同步日志 | `~/.codex/plugin-i18n-native/sync.log` |
| 稳定运行目录 | `~/.codex/plugin-i18n-native/tool` |

计划任务名称：`CodexPluginZhNativeSync`

## 更新韧性

Codex 更新重置来源清单后，同步器会重新发现本地 marketplace，并按插件 ID、字段和源文本哈希命中缓存，将中文写回。

被翻译插件更新时：

- 源文本未变化：复用原译文。
- 源文本变化：只翻译新增或变化的字段。
- 来源路径变化：更新状态中的路径并保存新原清单备份。
- Codex app-server 不可用：退回 CLI 和文件扫描。

插件自身更新时，版本化安装缓存只作为运行时代码来源；计划任务始终运行稳定目录中的脚本，翻译缓存、备份和状态不会被覆盖。

## 限制

- 这是非官方的本地 manifest 覆盖层。
- 远端 Git 来源插件不能通过本地清单覆盖。
- 如果未来 Codex 彻底改变插件清单协议，可能需要更新适配逻辑。
- 如果上游插件只修改底层英文描述、同时保留已覆盖的 `interface` 字段，可能需要等待 Codex 重写清单或手动同步触发刷新。

## 项目结构

```text
.agents/plugins/marketplace.json   # 本地 marketplace 元数据
plugins/native-plugin-zh/          # 插件源码
```

插件详细说明见 `plugins/native-plugin-zh/README.md`。
