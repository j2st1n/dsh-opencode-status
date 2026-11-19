# dsh-opencode-status

OpenCode GO 套餐用量与配额状态监控面板插件（DeepSeek Harness）：侧栏常驻极简单行胶囊按钮，点击即打开用量面板，查看 5h 滚动窗口、周窗口、月窗口的剩余额度与重置倒计时，并可手动刷新或进入独立设置视图。

## 功能特性

- **点击打开用量面板**：侧栏常驻按钮（`● OpenCode · 月剩余 70%`）点击后打开的是用量面板（默认用量视图），不再是只弹出连接配置表单；按剩余额度着色（>50 正常、>20 警告、其余错误），rail 模式下同样是可点击的真按钮。
- **固定底部操作条**：
  - `↻ 刷新`：通过 `POST /api/opencode-status/sync` 绕过 30 秒缓存，强制重新拉取当前剩余额度；刷新期间按钮禁用并显示旋转与「刷新中…」，完成后面板与侧栏数值同步更新，失败时在面板内显示错误文案而不是静默。
  - `⚙ 设置`：进入面板内的独立连接设置视图，可随时 `← 返回用量`。
  - 右侧显示相对时间「上次同步 12s 前」（刚刚 / Ns 前 / N 分钟前 / N 小时前 / N 天前），绝对时刻 HH:MM:SS 保留在 `title`；同步数据超过 2 分钟追加「· 可能已过期」并用警告色，避免把旧额度当成实时值。
- **3 维度用量行**：主百分比只给剩余额度，进度条条长与它同源（条长 = 剩余占比，条色 = 剩余档位），「已用」放在 `title` 与 `aria-valuetext` 里，同一行不再重复表达同一个数字；窗口状态非 `ok` 时给出可见提示。
  - **滚动窗口 (5h)**：`剩余 70% · ⏱ 4h20m`
  - **周窗口**：剩余 % + ⏱ 重置倒计时
  - **月窗口**：剩余 % + ⏱ 重置倒计时
  - 面板头部只显示连接状态（`已连接` / `异常`），不再给「最紧张」摘要——哪个窗口最紧，看三条进度条一眼就知道。
- **可访问性与键盘交互**：
  - 面板是 `role="dialog"`，`aria-label` 随视图切换（「OpenCode GO 用量」/「OpenCode GO 连接配置」）。
  - `Esc` 关闭面板；`Tab` 在面板内首尾循环；打开时焦点移入面板，关闭（含 Esc）后归还到打开前的触发按钮，点击面板外关闭时不抢焦点。
  - 面板允许点击外部关闭，属非模态对话框，因此**不声明** `aria-modal`。
  - 每个窗口的进度条是 `role="progressbar"`，带 `aria-valuemin` / `aria-valuemax` / `aria-valuenow`（取整剩余额度）与 `aria-valuetext`（「剩余 X%，已用 Y%，档位」）；数据不可用时只报「数据不可用」，不给数值。
  - 低额度除颜色外还有文字徽标（`⚠ 即将耗尽` ≤20%、`⚠ 偏低` ≤50%），色觉障碍与灰度截图也能读出档位。
  - 面板宽度为 `min(360px, calc(100vw - 24px))`，窄窗口（<372px）不再右侧溢出。
- **连接设置视图**：未配置（`mode === 'needs_config'`）时面板直接显示设置视图；保存成功后自动回到用量视图；「取消」丢弃未保存的编辑并关闭面板。密钥仅存入宿主凭据库（`OPENCODE_GO_API_KEY`），API 响应不回传明文。数据口径说明（上游只提供百分比、界面不展示金额余额）放在此视图底部，不占用用量视图。
- **220ms 悬浮微卡**：鼠标悬停常驻按钮 220ms 后在面板关闭且连接正常时出现，展示标题 + GO 标识 + 最近同步时间（相对时间）、三个窗口的紧凑行（名称 / 剩余 % / ⏱ 重置倒计时 / 细进度条）与底部「点击查看详情」；纯展示卡片，不拦截按钮点击。
- **缓存与刷新**：服务端 30 秒缓存 + 客户端 30 秒自动刷新。自动轮询是插件级单例：插件激活时安装一次，侧栏按钮组件卸载（侧栏收起、布局切换）不会停表，只有插件被卸载 / 热替换时才随生命周期释放（避免旧 ticker 残留）；页面隐藏期间保留 ticker、由浏览器自行节流，恢复可见时立即补拉一次。打开面板、切换视图不会额外探测上游，手动刷新是唯一绕过缓存的入口。
- **额度语义**：上游 `/v1/usage` 只提供 rolling/weekly/monthly 百分比，没有 USD 余额接口（[anomalyco/opencode#10448](https://github.com/anomalyco/opencode/issues/10448) 仍 open），因此界面只展示「剩余额度 / 可用百分比」，不编造金额余额；百分比由宿主统一取整并钳制到 0–100，剩余与已用恒和 100。

## 安装与更新

### 兼容性（DSH 0.2.x）

- 本版本（`0.4.x`）面向 **DeepSeek Harness 0.2.x**，已在 `0.2.2-rc.1` 上验证；`package.json` 通过 `engines.dsh: ">=0.2.0 <0.3.0-0"` 声明兼容范围（上界带 `-0` 显式排除 0.3.0 的预发布版；宿主用 semver `includePrerelease` 校验，已用其 `evaluatePluginCompatibility` 验证 `0.2.2-rc.1` 为 COMPATIBLE、`0.3.0-rc.1`/`0.3.0-rc.2`/`0.3.0` 为 UNMET）。
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

点侧栏常驻按钮打开用量面板，再点面板底部「⚙ 设置」进入连接设置视图；未配置时面板会直接显示设置视图：
- **Base URL**：默认 `https://opencode.ai/zen/go`（也可用环境变量 `OPENCODE_BASE_URL` 提供未持久化时的默认值）
- **API Key**：粘贴你的 OpenCode API Key（亦可直接在环境变量中配置 `OPENCODE_GO_API_KEY`）

保存成功后自动回到用量视图；「取消」丢弃未保存的编辑并关闭面板，重新打开时表单从已保存配置重新渲染。

配置存储方式（DSH 0.2.x）：
- **Base URL** 属于插件 `Config` 的 `volatile` 字段：修改时通过宿主的 settings 服务写回当前 profile 条目（`opencode-status`），重启后依然生效；宿主未提供 settings 服务时，修改 Base URL 会返回明确的错误响应，插件不会崩溃。
- **API Key** 只写入宿主凭据库（默认引用 `OPENCODE_GO_API_KEY`），HTTP 响应仅返回 `••••` 掩码提示，不回传明文。
- 状态缓存命中时会校验 baseUrl 与 keyRef，因此在 DSH 设置页改动配置后，下一次读取立即生效，无需等待 30s 缓存过期。

## 安全说明

- 默认部署只监听本机 loopback，所有响应带 `Cache-Control: no-store`；绑定其它地址时（`--host` / 反代），写请求是否放行取决于 bind 地址白名单与 `connection.trustedHosts`。
- `GET` 与 `PUT` / `POST` 共用同一套 Host/来源防护，读路径同样会拒绝 DNS rebinding（攻击者页面无法读取配额、`baseUrl` 或密钥掩码）：
  - **Host 白名单**：Host 必须可解析，且 hostname 属于 loopback（`localhost`、`[::1]`、`127/8`）、等于监听器 bind 地址（`ctx.webServer.host`），或命中 `ctx.get('connection')?.trustedHosts`；宿主提供官方 `isTrusted(req)` 时直接采用其结论；
  - 请求带 `sec-fetch-site: cross-site` 时直接拒绝；
  - 带 `Origin` 头时必须是同一 authority（Host 的默认端口按 Origin 的 scheme 归一化，对齐 `isSameAuthorityOrigin`），否则返回 `403 FORBIDDEN`，且不会读取或写入凭据与配置。
- 写请求在上述防护之外还要求 `content-type: application/json`（允许 `charset` 参数），不满足时返回 `415 UNSUPPORTED_MEDIA_TYPE`（与宿主 `client-connection` 语义一致）。
- 不支持的方法仍返回 `405`（先于来源判定）。
- 请求体上限 64KB，超出返回 `413`；JSON 解析失败返回 `400`（错误码 `INVALID`）。
- API Key 只在宿主凭据库中保存，HTTP 响应仅回传尾 4 位掩码。
- **残余风险**：端点只做来源校验，不做浏览器会话鉴权，同机进程仍可直接访问 loopback 端点；后续可把操作迁到带鉴权的 `/api` RPC（复用宿主 `connection.admit` 的 Peer 鉴权）。

## License

[Apache-2.0](./LICENSE)
