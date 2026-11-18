# Changelog

## 0.3.0

- 重构点击交互：侧栏常驻按钮改为打开用量面板（默认用量视图），不再直接弹出连接配置表单；参考 dsh-cpa-status 的双视图范式。
- 用量面板新增固定底部操作条：`↻ 刷新` 通过 `POST /api/opencode-status/sync` 绕过 30 秒缓存强制重新拉取当前剩余额度（带 `content-type: application/json`，刷新期间按钮禁用并显示旋转 +「刷新中…」），完成后侧栏与面板数值同步更新；右侧固定展示「上次同步 HH:MM:SS」（取 `status.fetchedAt`）。刷新失败时在面板内显示错误文案，不再静默。
- 设置改为面板内的独立视图（Base URL + API Key），底部 `⚙ 设置` 进入、`← 返回用量` 退出；保存成功后自动回到用量视图。`mode === 'needs_config'` 时面板直接显示设置视图；「取消」保持 0.2.3 语义：丢弃未保存的编辑并关闭面板。
- 用量面板的三个窗口行同时给出已用 % 与剩余 %、重置倒计时和进度条；颜色按剩余额度阈值（>50 正常、>20 警告、其余错误）着色，与 cpa 的 QuotaBar 语义一致；窗口 `status` 非 `ok` 时给出可见提示。
- 重新设计 220ms 悬浮微卡：标题 + GO 标识 + 最近同步时间，三个窗口的紧凑行（名称 / 剩余 % / ↻ 重置倒计时 / 细进度条），底部「点击查看详情」；卡片为纯展示（无假按钮），并设置 `pointer-events: none` 不遮挡 footer 按钮的点击。
- 侧栏常驻按钮按剩余额度着色（>50 正常、>20 警告、否则错误），文案改为「月剩余 N%」摘要；rail 模式（`wide === false`）渲染为真正的 `button`（键盘可达），点击同样打开用量视图。
- 保留 30 秒 GET 自动刷新；打开面板 / 切换视图只走 30 秒缓存，不触发额外的上游探测，手动刷新是唯一绕过缓存的入口。
- 测试目录新增 `test/index.js` 目录入口垫片：Node 22.23 的 `node --test <dir>` 不再展开目录参数，垫片让 `node --test dsh-plugins/dsh-opencode-status/test/` 与 `node --test` 两种调用方式都能执行同一套用例。
- 明确额度语义：上游 `/v1/usage` 只返回 rolling/weekly/monthly 百分比，没有 USD 余额接口（anomalyco/opencode#10448 仍 open），面板只表述「剩余额度 / 可用百分比」，不编造金额。
- store 用 `view: 'status' | 'settings'` 表达面板视图，不引入已废弃的 `editing` 标识。
- 修复评审 F2/F3：手动刷新发起时推进请求序号 `statusEpoch`，更早发出的在途 GET 响应（含失败）不再覆盖 `store.status` / `store.error`，手动刷新自身结果仍正常落库，30 秒轮询行为不变；设置视图的「← 返回用量」在 status 尚未加载（null）时也可见，仅 `mode === 'needs_config'` 时隐藏。
- 测试更新：新增刷新按钮 `POST /sync` 且带 JSON 内容类型、设置入口与视图切换、悬浮卡上次同步、侧栏着色与 rail button、剩余额度阈值着色、窗口异常提示、版本号与文档一致性断言；原有安全与配置用例保持通过（共 35 个用例，含最小 React stub 下的客户端加载、rail button、设置视图返回入口冒烟，以及 F2 的静态断言与「旧 GET 在 POST 之后返回/失败」运行时竞态回归）。
- 版本号升至 `0.3.0`；README 的功能特性与配置说明同步更新。

## 0.2.3

- 修复配置面板「取消」按钮点击无反应：该按钮此前只翻转 `editing` 标记，而 0.1.5 的弹窗重构之后已没有任何渲染逻辑读取它。现在「取消」会丢弃未保存的编辑并关闭面板，重新打开时表单从已保存配置重新渲染。
- 移除 store 中已废弃的 `editing` 字段及其全部写入点。
- 测试增至 26 个用例，新增客户端「取消」处理函数的静态回归。

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
