# Changelog

## 0.2.2

- 修复 content-type 回归用例被 Host fence 掩盖的问题：原用例没带 `Host`，请求在来源检查阶段就被拒绝，因此删掉 content-type 校验后测试仍然全绿。现在用例明确带可信 `Host`、断言 `415 UNSUPPORTED_MEDIA_TYPE` 与错误消息，并校验凭据未被修改。
- `GET` 路由补上与写请求相同的 Host/来源 fence，闭合 DNS rebinding 的读取路径（此前攻击者可读取配额、`baseUrl` 与密钥尾四位掩码）。默认部署（loopback / bind 地址 / `connection.trustedHosts`）不受影响；宿主提供 `connection.isTrusted` 时，读与写都委托官方判定。
- 写请求 content-type 不合法时由 `403 FORBIDDEN` 改为 `415 UNSUPPORTED_MEDIA_TYPE`，与宿主 `client-connection` 的语义保持一致。
- 新增两条回归：GET 的 rebinding / 缺 Host / loopback 放行；`connection.isTrusted` 委托在读写两条路径上的放行与拒绝。
- 文档：README 安全说明区分「默认部署只监听 loopback」与「绑定其它地址时依赖 bind 地址白名单或 `trustedHosts`」，补充读路径 fence 与 415 语义；修复 CHANGELOG 中重复的 `## 0.2.0` 标题。
- 测试增至 25 个用例。

## 0.2.1

- package.json 增加 `engines.dsh: ">=0.2.0 <0.3.0-0"` 兼容声明，版本升到 0.2.1。上界写成 `<0.3.0-0` 是为了让 0.3.0 的预发布版同样 UNMET；已用宿主 app-boot 的 `evaluatePluginCompatibility` 实测：`0.2.2-rc.1` → COMPATIBLE，`0.3.0-rc.1` / `0.3.0-rc.2` / `0.3.0` → UNMET（旧的 `>=0.2.0 <0.3.0` 会把 `0.3.0-rc.1`、`0.3.0-rc.2` 误判为 COMPATIBLE）。
- 请求体 JSON 解析失败时返回 `400` + 错误码 `INVALID`（此前会落到 guard 的 500）；`64KB` 请求体上限仍返回 `413`，非对象 JSON 同样返回 `400 INVALID`。
- 状态缓存（30s TTL）命中条件增加 baseUrl 与 keyRef 比对：在设置页热改配置后，下一次 `GET /api/opencode-status` 立即重新拉取，不再等 TTL 过期；`PUT` 里的显式缓存失效保留。
- `PUT` / `POST` 写请求增加与宿主 `client-connection` 对齐的来源防护：`content-type` 必须为 `application/json`（允许 charset）；`Host` 白名单要求 hostname 属于 loopback（`localhost`、`[::1]`、`127/8`）、等于 `ctx.webServer.host` 的 bind 地址，或命中 `ctx.get('connection')?.trustedHosts`（宿主提供官方 `isTrusted(req)` 时直接采用其结论）；拒绝 `sec-fetch-site: cross-site`；带 `Origin` 时必须是同一 authority（`Host` 的默认端口按 `Origin` 的 scheme 归一化，对齐 `isSameAuthorityOrigin`）。否则返回 `403 FORBIDDEN` 且不触碰凭据与配置。`GET` 行为不变，不支持的写方法仍返回 `405`。
- 客户端强制刷新（`POST /api/opencode-status/sync`）补上 `content-type: application/json`，避免被新的写请求防护拦截。
- 测试增至 23 个用例，新增 malformed JSON→400、跨源 Origin→403、非 JSON content-type→403、热改配置缓存失效、`engines.dsh` 与客户端请求头断言，以及 DNS rebinding→403（零写入）与 loopback/localhost/bind/trustedHosts 浏览器形态→200 两条回归。
- 残余风险（后续项）：写端点只做来源校验、不做浏览器会话鉴权，同机进程仍可直接访问 loopback 端点；后续可把写操作迁到带鉴权的 `/api` RPC（复用宿主 `connection.admit` 的 Peer 鉴权）。

## 0.2.0

- 适配 DSH 0.2.x：宿主端改用官方 `Config`（schemastery）schema，`baseUrl` 与 `keyRef` 声明为 `volatile` 字段，删除已被移除的旧配置注册调用，修复插件在 0.2.2-rc.1 上无法激活的问题。
- `apply(ctx, config)` 同时兼容 plain 配置值与 volatile live ref（`{ get() }` 形态），字段缺失时回退到环境变量 / 官方端点与默认密钥引用。
- Base URL 修改通过宿主的 settings 服务持久化到 profile 条目 `opencode-status`；宿主未提供该服务或写入失败时返回 `SETTINGS_UNAVAILABLE` / `PERSIST_FAILED` 的 409 响应，不再抛到路由外。
- 保持对外行为不变：4 个 HTTP 端点（含 GET/PUT 配置与 POST 同步）的状态码与响应结构、30s 缓存、10s 超时、64KB 请求体上限、`no-store`、405 分支、密钥脱敏提示与错误码均未改变；API Key 仍只存放于 credentials。
- 依赖升级到 `@deepseek-ai/schemastery@^3.19.0`（volatile 字段支持）。
- 测试迁移到新的 Config 读取路径，并补充 volatile ref、settings 成功 / 缺失 / 失败三条路径与 Config 导出断言。

## 0.1.5

- 消除点击弹窗中的重复进度条展示：用量进度条与倒计时全部由 220ms 悬浮微卡呈现（免点即看），点击按钮直达「⚙ OpenCode GO 连接配置」管理卡片（配置 Base URL、设置 API Key、清除 Key 与强制同步）。

## 0.1.4

- 增加侧边栏鼠标悬停（Hover 220ms）3 维用量卡片预览：5h 滚动窗口、周窗口、月窗口实时用量条与重置倒计时鼠标悬停即看，免去频繁点击与关闭的交互负担。

## 0.1.3

- 优化 README 安装命令为官方 npm 源优先。

## 0.1.2

- 修复自定义 `keyRef` 配置下凭据读取、写入与清除目标不一致的问题
- 让 `OPENCODE_BASE_URL` 正确作为未配置 profile 的默认地址
- 实现 `/api/opencode-status/sync` 并让客户端通过该接口强制刷新
- 增加凭据引用、同步路由和环境变量默认值回归测试

## 0.1.1

- 放大右上角设置（⚙）、刷新（↻）、关闭（✕）触控区域，提升交互手感与可点击性
- 统一侧栏状态指示灯对齐基准线与自适应弹性文本

## 0.1.0

- 侧栏极简状态胶囊按钮（`● OpenCode · 月用量 58%`），异常自动变色，默认不打扰
- 点击弹出轻量悬浮面板，展示 Rolling (5h)、Weekly、Monthly 进度条与重置倒计时
- 支持直接在面板内配置 OpenCode API Key 与 Base URL，密钥安全保存在宿主凭据库
- 支持手动刷新与自动缓存
