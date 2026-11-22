# 原生插件中文化 Marketplace

这是 `native-plugin-zh` 的 Codex marketplace 发布目录，当前插件版本 **1.6.0**。

插件启用后会监听本地插件清单：Codex 更新、目标插件更新或新装本地插件后，只自动翻译新增和英文变化的名称、简介与详细说明；英文未变的字段复用缓存。

## 安装

从 GitHub 安装：

```powershell
codex plugin marketplace add kinlaite/codex-native-plugin-zh --ref main
codex plugin add native-plugin-zh@native-plugin-zh-local
```

或从解压后的本地目录执行：

```powershell
codex plugin marketplace add <本目录的绝对路径>
codex plugin add native-plugin-zh@native-plugin-zh-local
```

随后启用插件、批准 hooks，并重启 Codex。

## 要求

- Windows 10/11 的 Codex 桌面版
- Codex 自带 Node 运行时，或 PATH 中的 Node.js 20+
- 自动重启需要 WMI；可在 `~/.codex/plugin-i18n-native/settings.json` 设置 `"autoRestartApp": false`

详细说明、数据边界和卸载方式见 `plugins/native-plugin-zh/README.md`。
