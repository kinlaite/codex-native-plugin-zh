# 原生插件中文化（native-plugin-zh）

直接在 Codex 插件市场、已安装列表和详情页中显示中文名称、简介与详细说明。

这是主插件，负责发现本地插件、写入中文、维护翻译缓存和备份。关闭主插件后的英文恢复由同仓库的独立插件 `native-plugin-zh-guard` 完成，二者必须一起安装。

## 生命周期

- **启用并重启 Codex**：`SessionStart` 或 MCP 启动时用缓存写入中文。
- **关闭并重启 Codex**：主插件已被 Codex 卸载，因此不会执行；独立的恢复守护插件在 `SessionStart` 检测到主插件关闭，恢复英文原值。
- **手动恢复**：`native_zh_restore` 恢复英文并暂停中文化；普通重启不会重新写入。
- **重新应用**：调用 `native_zh_apply`，或关闭再重新启用主插件。

为什么不在主插件里用 `SessionEnd`：Codex 禁用插件后会立即移除该插件的 hooks 和 MCP，`SessionEnd` 不保证执行；强制结束进程时也不会执行。恢复守护插件是独立安装的普通插件，关闭主插件不会关闭它，因此能在下次启动时完成恢复。

## 安全边界

- 不修改 Codex 本体、`app.asar`、WindowsApps 或本插件自身的安装缓存。
- 只改写 Codex 实际读取的本地插件源清单（bundled marketplace、runtime 插件目录或本地 marketplace），写入前保存原清单备份。
- 代码不写死用户名、盘符或本机安装路径；`CODEX_HOME`、用户目录和 Codex/Node 位置都在运行时解析。
- 写入前保存完整原清单；备份用源英文重建，不会把正在生效的中文写成“原值”。
- 恢复默认跳过用户编辑、已删除字段和同步期间被外部改写的值，不覆盖也不重建。
- 状态、翻译缓存、备份和审计位于 `~/.codex/plugin-i18n-native`，不在插件包内，因此插件升级不会覆盖。
- 不使用计划任务、常驻后台进程、外部服务或稳定运行目录。

## 安装

```powershell
codex plugin marketplace add kinlaite/codex-native-plugin-zh --ref main
codex plugin add native-plugin-zh@native-plugin-zh-local
codex plugin add native-plugin-zh-guard@native-plugin-zh-local
```

启用两个插件、分别批准 hooks，然后重启 Codex。恢复守护插件必须保持启用。

## 恢复

正常方式是关闭主插件并重启 Codex，由恢复守护插件恢复英文。也可以调用 `native_zh_restore`。

如果恢复守护未安装、未启用或 hooks 未获批准，可从任意已安装版本直接执行：

```powershell
$cli = Get-ChildItem "$env:USERPROFILE\.codex\plugins\cache\native-plugin-zh-local\native-plugin-zh" `
  -Recurse -Filter cli.mjs |
  Where-Object { $_.FullName -match '\\scripts\\cli\.mjs$' } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
node $cli.FullName restore
```

旧版手动暂停会被保留；计划任务删除失败时会保留残留并在下次启动重试。

## 限制

- 恢复守护插件必须保持启用；它未运行时无法自动恢复英文。
- 极端锁争用、hooks 未批准或 Codex 提前移除 hooks 时，关闭恢复可能无法完成；使用上面的 CLI。
- 远端 Git 来源插件不能通过本地 manifest 覆盖。
- 这是非官方、可恢复的本地覆盖层；若 Codex 未来彻底改变插件清单或 hooks 协议，需要更新适配逻辑。
