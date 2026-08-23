# dsh-opencode-status

OpenCode GO 套餐用量与配额状态监控面板插件（DeepSeek Harness）：侧栏常驻极简单行胶囊按钮，点开即看 5h 滑动窗口、周窗口、月窗口用量进度条与重置倒计时。

## 功能特性

- **极简常驻态**：单行状态胶囊（`● OpenCode · 月用量 58%`），平时低调克制，超额预警时自动变色，默认不打扰。
- **3 维度用量进度条**：
  - **滚动窗口 (5h)**：实时用量 % + 下次重置倒计时（如 `↻ 4h20m`）
  - **周窗口 (Weekly)**：周额度消耗 % + 重置倒计时
  - **月窗口 (Monthly)**：月额度消耗 % + 重置倒计时
- **内置安全配置卡片**：直接在弹窗内配置 API Key 与 Base URL，密钥仅存入宿主凭据库（`OPENCODE_GO_API_KEY`），API 响应不回传明文。
- **平滑交互**：悬浮面板智能定位，点击外部空白区域自动收起，用完即走。
- **多端同步与缓存**：服务端 30s 智能缓存，支持一键手动强制刷新。

## 安装与更新

### 1. 一键安装（自动拉取最新最新版）

```sh
dsh plugin --profile web add github:j2st1n/dsh-opencode-status
```

> **说明**：
> - 无需指定版本号，默认直接拉取 GitHub 上的**最新版本**（相当于 `@latest`）；
> - 若需锁定特定稳定版本，可指定 Tag：`dsh plugin --profile web add github:j2st1n/dsh-opencode-status#v0.1.1`；
> - 安装后重启 `dsh web` 即可立即生效。

### 2. 卸载

```sh
dsh plugin --profile web remove dsh-opencode-status
```

## 配置

点侧栏「连接 OpenCode」或弹窗右上角「⚙」配置：
- **Base URL**：默认 `https://opencode.ai/zen/go`
- **API Key**：粘贴你的 OpenCode API Key（亦可直接在环境变量中配置 `OPENCODE_GO_API_KEY`）

## License

[Apache-2.0](./LICENSE)
