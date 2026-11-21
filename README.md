# Codex 原生插件中文化

在 Codex 的插件市场、已安装列表和详情页中，直接把英文名称、简介和详细说明替换为简体中文。

> 非 OpenAI 官方项目。它通过可恢复的本地插件清单覆盖层工作，请先备份并确认符合你的使用需求。

## 插件组成

本仓库包含两个普通 Codex 插件，必须一起安装：

| 插件 | 作用 |
| --- | --- |
| `native-plugin-zh` | 主插件：MCP 工具、`SessionStart` 写入、翻译缓存和恢复工具 |
| `native-plugin-zh-guard` | 恢复守护：只注册 `SessionStart`，在主插件关闭或卸载后恢复英文 |

为什么需要第二个插件：Codex 关闭某个插件时，会立即卸载该插件的 MCP，并停止加载它的 hooks。主插件无法在“关闭”瞬间执行恢复；`SessionEnd` 也不能可靠覆盖“禁用插件”和“强制结束”这两种情况。守护插件是独立安装的，关闭主插件不会关闭它，因此下次 Codex 启动时它仍能收到 `SessionStart` 并完成恢复。

两个插件都不修改 Codex 本体、`app.asar` 或 WindowsApps 安装目录。主插件只改写 Codex 实际读取的本地插件源清单（bundled marketplace、runtime 插件目录或本地 marketplace），并在写入前把原清单备份到 `~/.codex/plugin-i18n-native/backups`。不安装计划任务，不创建常驻后台进程，不依赖外部服务，也不使用稳定运行目录。运行数据只保存在 Codex 自己的 `~/.codex/plugin-i18n-native` 数据目录。

代码不写死用户名、盘符或本机安装路径；`CODEX_HOME`、用户目录和 Codex/Node 位置都在运行时解析。换机、改用户名或移动 marketplace 后，插件仍按当前环境重新发现目标插件。

## 生命周期

插件开关就是中文化的生命周期开关。操作后重启 Codex：

| 操作 | 执行者 | 结果 |
| --- | --- | --- |
| 启用主插件并重启 | 主插件 `SessionStart` 或 MCP 启动 | 从翻译缓存写入中文；首次运行会扫描本地插件 |
| 关闭主插件并重启 | 守护插件 `SessionStart` | 恢复英文原值，保留中文化偏好、翻译缓存和备份 |
| 在插件仍启用时手动恢复 | `native_zh_restore` | 恢复英文并暂停中文化；普通重启不会重新写入 |
| 再次启用中文化 | `native_zh_apply`，或先关闭再重新启用主插件 | 使用已有缓存重新写入中文 |

守护插件只在主插件关闭时工作；主插件开启时它不做任何写入。恢复前会在锁内再次读取主插件开关，避免用户在启动过程中重新打开主插件时误恢复。

## 安装

从 GitHub 安装：

```powershell
codex plugin marketplace add kinlaite/codex-native-plugin-zh --ref main
codex plugin add native-plugin-zh@native-plugin-zh-local
codex plugin add native-plugin-zh-guard@native-plugin-zh-local
```

也可以在本地开发目录安装：

```powershell
codex plugin marketplace add .
codex plugin add native-plugin-zh@native-plugin-zh-local
codex plugin add native-plugin-zh-guard@native-plugin-zh-local
```

然后在 Codex 插件页面：

1. 启用“原生插件中文化”。
2. 启用“原生插件中文化 · 恢复守护”，并保持启用。
3. 分别批准两个插件的 hooks。
4. 重启 Codex。

Codex 以插件内容哈希校验 hooks；插件更新改变 hooks 包时，Codex 可能再次要求批准。这是 Codex 的安全边界，插件不会绕过。

## 使用

安装后，插件包和数据是分离的：

- Codex 更新或重新安装插件时，翻译缓存、状态和备份不会被覆盖。
- 目标插件更新后，未被覆盖的英文源文本按插件 ID、字段和 SHA-256 重新匹配；没有变化的文本继续使用旧译文。
- 新增或变化的英文需要调用 `native_zh_sync` 增量翻译；启动流程只使用已有缓存，不会阻塞 Codex 启动去等待模型翻译。

MCP 工具：

| 工具 | 用途 |
| --- | --- |
| `native_zh_status` | 查看开关、覆盖状态、恢复守护状态、待写入字段和待翻译字段 |
| `native_zh_apply` | 使用已有缓存立即写入中文；恢复守护未启用时会提示 |
| `native_zh_sync` | 重新发现本地插件，按需增量翻译并同步 |
| `native_zh_restore` | 手动恢复英文并暂停中文化 |
| `native_zh_uninstall` | 恢复英文，可选清理运行数据 |
| `native_zh_diagnose` | 检查主插件开关、恢复守护、hooks 信任、Codex/Node 定位和错误 |

插件页面若已经打开，写入后刷新页面即可看到中文。

## 恢复与卸载

正常恢复英文：

1. 在 Codex 插件页面关闭“原生插件中文化”。
2. 重启 Codex。
3. 守护插件的 `SessionStart` 会把仍处于缓存中文状态的字段恢复为原英文。

也可以先调用 `native_zh_restore`，再关闭插件并重启。手动恢复会保留翻译缓存和备份，便于以后重新启用。

如果守护插件未安装、未启用或 hooks 未获批准，关闭主插件后不会自动恢复。此时可对任意已安装版本直接执行一次恢复，不需要计划任务或稳定目录：

```powershell
$cli = Get-ChildItem "$env:USERPROFILE\.codex\plugins\cache\native-plugin-zh-local\native-plugin-zh" `
  -Recurse -Filter cli.mjs |
  Where-Object { $_.FullName -match '\\scripts\\cli\.mjs$' } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
node $cli.FullName restore
```

如果某个字段在中文覆盖期间被上游或用户改写，恢复会跳过该字段并写入审计历史，不会覆盖新的编辑，也不会把用户删除的字段重新创建出来。恢复不完整时，`uninstall --purge` 会拒绝删除备份。

卸载：

```powershell
codex plugin remove native-plugin-zh@native-plugin-zh-local
codex plugin remove native-plugin-zh-guard@native-plugin-zh-local
```

卸载主插件前建议先恢复英文。只卸载主插件时，守护插件会保留并在下次启动时再次检查；要彻底移除整套功能，再卸载守护插件。翻译缓存、备份和审计记录默认保留在 `~/.codex/plugin-i18n-native`；需要彻底清理时可调用 `native_zh_uninstall` 并设置 `purge=true`。

## 运行数据

| 内容 | 路径 |
| --- | --- |
| 状态 | `~/.codex/plugin-i18n-native/state.json` |
| 翻译缓存 | `~/.codex/plugin-i18n-native/translations.zh-CN.json` |
| 原清单备份 | `~/.codex/plugin-i18n-native/backups` |
| 审计历史 | `~/.codex/plugin-i18n-native/history.jsonl` |
| 运行日志 | `~/.codex/plugin-i18n-native/sync.log` |

插件代码由 Codex 从 marketplace 安装到版本化缓存中；本项目不在数据目录保留第二份可执行代码。

## 更新韧性

- **Codex 更新**：重新扫描当前本地 marketplace 根目录和插件来源清单，使用插件 ID、字段和源文本哈希命中缓存。
- **目标插件更新**：英文未变时复用译文；英文变化时只处理变化字段；来源路径变化时更新状态并备份新原清单。
- **主插件更新**：代码由 Codex 版本化缓存替换，状态、翻译、备份和审计仍保留在数据目录；守护插件独立存在，不依赖主插件当前版本。
- **守护插件更新**：只影响下一次 `SessionStart` 的恢复实现，不改变主插件的写入逻辑。
- **Codex hooks 协议变化**：无法保证跨任意未来版本永久兼容；此时升级适配代码即可，已写入英文可通过备份和 CLI 恢复。

备份使用源英文重建干净的原清单，不会把正在生效的中文写进备份。若 `state.json` 损坏、丢失或写入过程被打断，启动和恢复流程会读取 `backups` 与翻译缓存，只在“当前值仍等于缓存译文”时回写原英文，避免覆盖上游后来更新的内容。

## 限制

- 目前面向 Windows 上的 Codex 桌面版。
- 恢复守护插件必须保持启用并批准 hooks；否则关闭主插件后不会自动恢复。
- 远端 Git 来源插件不能通过本地清单覆盖。
- 不使用外部常驻进程是本项目的设计选择；恢复依赖“关闭主插件后正常重启 Codex”、守护插件 hooks 已批准，或手动恢复。
- hooks 和 MCP 使用系统级互斥锁；极端锁争用或进程被硬终止时仍需手动恢复。
- 如果未来 Codex 彻底改变插件清单或 hooks 协议，需要更新适配逻辑。

## 开发与验证

```powershell
cd plugins/native-plugin-zh
node --test test/*.test.mjs
node test/mcp-smoke.mjs

cd ../native-plugin-zh-guard
node --test test/*.test.mjs
```

仓库结构：

```text
.agents/plugins/marketplace.json       # marketplace 元数据
plugins/native-plugin-zh/              # 主插件源码
plugins/native-plugin-zh-guard/        # 恢复守护插件源码
```

真实 Codex 闭环测试脚本位于工作区的 `work/plugin-mcp-e2e/e2e-guard.mjs`：开启主插件写入中文，通过 `config/batchWrite` 关闭主插件，重启后验证守护插件恢复英文，再重新开启验证中文。
