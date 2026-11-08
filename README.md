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

### 兼容性（DSH 0.2.x）

- 本版本（`0.2.x`）面向 **DeepSeek Harness 0.2.x**，已在 `0.2.2-rc.1` 上验证；`package.json` 通过 `engines.dsh: ">=0.2.0 <0.3.0-0"` 声明兼容范围（上界带 `-0` 显式排除 0.3.0 的预发布版；宿主用 semver `includePrerelease` 校验，已用其 `evaluatePluginCompatibility` 验证 `0.2.2-rc.1` 为 COMPATIBLE、`0.3.0-rc.1`/`0.3.0-rc.2`/`0.3.0` 为 UNMET）。
- DSH 0.2.x 移除了旧的插件配置注册接口，改为读取插件导出的 schemastery `Config`：`baseUrl`、`keyRef` 声明为 `volatile` 字段，由宿主生成配置表单并以 live ref 传入 `apply(ctx, config)`。因此 `0.1.x` 及更早版本在 DSH 0.2.x 上无法激活，请升级到 `0.2.0` 或更高版本。
- 升级方式：先把 DSH 升级到 0.2.x，再执行下面的安装命令（默认拉取 `@latest`），然后重启 `dsh web`。Base URL 会以插件配置写入当前 profile 的 `cordis.patch.yml`，API Key 仍保存在宿主凭据库，无需迁移。

### 1. 官方 npm 安装（推荐）

```sh
dsh plugin --profile web add dsh-opencode-status
```

### 2. GitHub 仓库直接安装

```sh
dsh plugin --profile web add github:j2st1n/dsh-opencode-status
```

> **说明**：
> - 无需指定版本号，默认拉取 `@latest` 最新版本；
> - 请使用 `0.2.0` 及以上版本，旧版无法在 DSH 0.2.x 上激活；
> - 安装后重启 `dsh web` 即可立即生效。

### 3. 卸载

```sh
dsh plugin --profile web remove dsh-opencode-status
```

## 配置

点侧栏「连接 OpenCode」或弹窗右上角「⚙」配置：
- **Base URL**：默认 `https://opencode.ai/zen/go`（也可用环境变量 `OPENCODE_BASE_URL` 提供未持久化时的默认值）
- **API Key**：粘贴你的 OpenCode API Key（亦可直接在环境变量中配置 `OPENCODE_GO_API_KEY`）

配置存储方式（DSH 0.2.x）：
- **Base URL** 属于插件 `Config` 的 `volatile` 字段：修改时通过宿主的 settings 服务写回当前 profile 条目（`opencode-status`），重启后依然生效；宿主未提供 settings 服务时，修改 Base URL 会返回明确的错误响应，插件不会崩溃。
- **API Key** 只写入宿主凭据库（默认引用 `OPENCODE_GO_API_KEY`），HTTP 响应仅返回 `••••` 掩码提示，不回传明文。
- 状态缓存命中时会校验 baseUrl 与 keyRef，因此在 DSH 设置页改动配置后，下一次读取立即生效，无需等待 30s 缓存过期。

## 安全说明

- 仅监听本机 loopback，所有响应带 `Cache-Control: no-store`。
- `PUT` / `POST` 写请求使用与宿主 `client-connection` 对齐的来源防护：
  - `content-type` 必须为 `application/json`（允许 `charset` 参数）；
  - **Host 白名单**：Host 必须可解析，且 hostname 属于 loopback（`localhost`、`[::1]`、`127/8`）、等于监听器 bind 地址（`ctx.webServer.host`），或命中 `ctx.get('connection')?.trustedHosts`；宿主提供官方 `isTrusted(req)` 时直接采用其结论。这阻断了 DNS rebinding（攻击者域名解析到本机后借用浏览器发起写请求）；
  - 请求带 `sec-fetch-site: cross-site` 时直接拒绝；
  - 带 `Origin` 头时必须是同一 authority（Host 的默认端口按 Origin 的 scheme 归一化，对齐 `isSameAuthorityOrigin`），否则返回 `403 FORBIDDEN`，且不会写入凭据或配置。
- `GET` 不受写防护影响；不支持的写方法仍返回 `405`。
- 请求体上限 64KB，超出返回 `413`；JSON 解析失败返回 `400`（错误码 `INVALID`）。
- API Key 只在宿主凭据库中保存，HTTP 响应仅回传尾 4 位掩码。
- **残余风险**：写端点只做来源校验，不做浏览器会话鉴权，同机进程仍可直接访问 loopback 端点；后续可把写操作迁到带鉴权的 `/api` RPC（复用宿主 `connection.admit` 的 Peer 鉴权）。

## License

[Apache-2.0](./LICENSE)
