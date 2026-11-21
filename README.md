# Claude Code mods

三个 Claude Code 的 mod（基于 function hooks 的插件）。

## gcp-billing — GCP 计费面板

在聊天旁边开一个“GCP 计费”面板，每分钟用 `gcloud compute instances list` 查询当前项目的虚拟机：

- 赠金余额推算：用 `/gcp-credit 166.66` 填一次控制台 Billing > Credits 里的剩余赠金，之后从审计日志还原每台虚拟机的开关机时间，按单价扣掉机器费、启动盘费和存储费，并按近 7 天日均估算还能用几天。读不到真实余额，不含下行流量和税；审计日志只保留 30 天，建议每两三周按控制台校准一次。每次重设时会用“控制台实际花掉 ÷ 推算花掉”算出校准系数（限制在 0.7–1.6），之后的推算乘上它，把流量、hyperdisk IOPS 等日志算不到的部分按比例补进来
- 运行中的机器：机型、区域、Spot/按需、磁盘、已运行时长、每小时单价和估算费用
- 已停止的机器：列出来，并提示磁盘仍按月计费
- 存储费：自定义镜像、未挂载的磁盘、快照、机器映像，按大小估算每月和每天的费用（每 10 分钟查一次）
- 状态栏显示运行台数和累计金额；单台运行超过 1 小时弹通知
- Colab Pro+：计算单元余额（及按 Pro+ 单价折算的美元）、当前消耗速率、正在计费的运行时数量，每 5 分钟查一次 `colab usage`（只读，不开运行时）
- `/gcp` 命令打开面板并立即刷新

要求：Windows，已安装并登录 [Google Cloud CLI](https://cloud.google.com/sdk)（`gcloud` 在 PATH 上，默认项目已设置）。

Colab 部分另需：WSL 里装好官方 Colab CLI 并登录过一次，路径为 `/root/envs/colab-cli/bin/colab`（例如 `python3 -m venv /root/envs/colab-cli && /root/envs/colab-cli/bin/pip install google-colab-cli keyrings.alt`，然后运行一次 `colab usage` 按提示登录）。路径不同可改 `register.tsx` 里的 `COLAB_CLI`。没装时面板的 Colab 部分只显示错误，GCP 部分照常工作。

单价表在 `plugins/gcp-billing/hooks/register.tsx` 的 `PRICES` 里，是 2026-11-09 查到的几种 G4 / G2 机型价格，不在表里的机型显示“单价未知”。估算只含机器和磁盘，不含流量，以实际账单为准。

## ink-paper-theme — 月白·青黛主题

桌面版和手机版的配色主题：灰调月白纸底、墨色文字、青黛强调色、低饱和砖红报错，背景铺一层极淡的七宝纹；夜间为冷调夜墨。终端不显示主题。

## navy-night — 深夜蓝主题

桌面版和手机版的配色主题：纯色深夜蓝背景（`#0b0f1a`），面板一层比一层略亮，冰蓝色强调色、琥珀色警告。没有背景图案和动画。终端不显示主题。主题只对已经启动的会话生效，新会话页面在发出第一条消息前是应用默认外观。

## 安装

在终端里的 Claude Code 会话中：

```
/plugin install gcp-billing --marketplace CXP-2024/claude-code-mods
/plugin install ink-paper-theme --marketplace CXP-2024/claude-code-mods
/plugin install navy-night --marketplace CXP-2024/claude-code-mods
```

第一次会问是否添加 marketplace，输入 `y`，再选安装范围（user 范围对之后所有会话生效）。

从 shell：

```
claude plugin install gcp-billing --marketplace CXP-2024/claude-code-mods
claude plugin install ink-paper-theme --marketplace CXP-2024/claude-code-mods
claude plugin install navy-night --marketplace CXP-2024/claude-code-mods
```

在桌面版里（不支持 `/plugin`）：点输入框旁的 **+** → **Plugins** → **Add marketplace**，填 `CXP-2024/claude-code-mods`，然后 **Add plugin**。

## License

MIT。各主题里的 `hooks/make-colors.js`、`make-colors.d.ts` 是 Claude Code mod 工具包自带的配色辅助文件，按工具包的说明原样复制使用。
