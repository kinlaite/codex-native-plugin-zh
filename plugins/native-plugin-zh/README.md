# 原生插件中文化（native-plugin-zh）

在 Codex 原生插件市场、已安装列表和详情页中直接显示中文名称、简介与详细说明。它修改的是 Codex 实际读取的本地 marketplace 源清单，而不是 `app.asar` 或安装缓存。

## 更新韧性

- 权威状态、翻译缓存、原清单备份和日志位于 `~/.codex/plugin-i18n-native`，不在插件包内。
- 插件每次启动或更新后，会把控制器代码同步到 `~/.codex/plugin-i18n-native/tool`，不会覆盖上述数据。
- Windows 计划任务直接运行稳定目录中的 PowerShell 脚本，并设置为登录时触发、每 5 分钟运行、错过计划后补跑、电池上仍运行、多实例忽略新实例、单次运行最多 30 分钟。任务返回码来自实际同步进程；启动时会检查任务是否被禁用、动作或触发器是否损坏，并自动重建。
- 所有写操作共用 Windows 命名管道互斥锁。计划任务、MCP 工具和手工命令同时启动时也只有一个进入写入流程；持锁进程崩溃后由系统自动释放，不依赖锁龄或删除旧锁文件。`sync.lock` 只记录当前持锁 PID 供诊断。翻译按批写入缓存，任务中断后下一次会从缓存继续。
- Codex 更新重置来源清单后，同步器按插件 ID、字段和源文本 SHA-256 命中旧翻译并自动写回中文。
- 被翻译插件只更改部分英文时，只补译新增或变化的字段。
- Codex app-server 协议变化时，会退回到 `codex plugin marketplace list --json`、配置文件 marketplace 根目录和已知目录扫描。

## 安装

```powershell
codex plugin marketplace add C:\Users\Admin\.codex\plugin-i18n-native\marketplace
codex plugin add native-plugin-zh@native-plugin-zh-local
```

安装后在 Codex 插件页启用并重启一次 Codex，让 MCP 和技能加载。

## 恢复英文

让 Codex 调用 `native_zh_restore`，或者运行：

```powershell
node C:\Users\Admin\.codex\plugin-i18n-native\tool\scripts\cli.mjs restore
```

恢复操作会暂停自动同步，但保留翻译缓存和备份。重新应用时运行 `apply`。

## 说明

这是非官方的本地 manifest 覆盖层。修改前会保存完整原清单；恢复默认拒绝覆盖同步期间被外部改写的字段。远端 Git 来源插件不能通过本地 manifest 覆盖。
