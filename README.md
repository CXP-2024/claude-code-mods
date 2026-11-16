# Claude Code mods

两个 Claude Code 的 mod（基于 function hooks 的插件）。

## gcp-billing — GCP 计费面板

在聊天旁边开一个“GCP 计费”面板，每分钟用 `gcloud compute instances list` 查询当前项目的虚拟机：

- 运行中的机器：机型、区域、Spot/按需、磁盘、已运行时长、每小时单价和估算费用
- 已停止的机器：列出来，并提示磁盘仍按月计费
- 状态栏显示运行台数和累计金额；单台运行超过 1 小时弹通知
- `/gcp` 命令打开面板并立即刷新

要求：Windows，已安装并登录 [Google Cloud CLI](https://cloud.google.com/sdk)（`gcloud` 在 PATH 上，默认项目已设置）。

单价表在 `plugins/gcp-billing/hooks/register.tsx` 的 `PRICES` 里，是 2026-11-09 查到的几种 G4 / G2 机型价格，不在表里的机型显示“单价未知”。估算只含机器和磁盘，不含流量，以实际账单为准。

## ink-paper-theme — 月白·青黛主题

桌面版和手机版的配色主题：灰调月白纸底、墨色文字、青黛强调色、低饱和砖红报错，背景铺一层极淡的七宝纹；夜间为冷调夜墨。终端不显示主题。

## 安装

在终端里的 Claude Code 会话中：

```
/plugin install gcp-billing --marketplace CXP-2024/claude-code-mods
/plugin install ink-paper-theme --marketplace CXP-2024/claude-code-mods
```

第一次会问是否添加 marketplace，输入 `y`，再选安装范围（user 范围对之后所有会话生效）。

从 shell：

```
claude plugin install gcp-billing --marketplace CXP-2024/claude-code-mods
claude plugin install ink-paper-theme --marketplace CXP-2024/claude-code-mods
```

在桌面版里（不支持 `/plugin`）：点输入框旁的 **+** → **Plugins** → **Add marketplace**，填 `CXP-2024/claude-code-mods`，然后 **Add plugin**。

## License

MIT
