# CPA Reauth Helper

批量给 [CLIProxyAPI (CPA)](https://github.com/router-for-me/CLIProxyAPI) 里失效的 codex 账号自动做 OAuth 重新授权。

## 它解决什么问题

CPA 跑久了，OpenAI 的 OAuth token 会因为各种原因失效（refresh 失败、被风控等），账号在管理面板上标为 `unavailable=true`。重新授权需要：

1. 调 `GET /v0/management/codex-auth-url` 拿一条新的 OAuth URL
2. 在浏览器里登录目标账号（可能要邮箱二次验证）
3. 完成 OAuth 同意页
4. 把 `localhost:1455/auth/callback?code=...&state=...` 这条回调 URL 喂回 CPA `POST /v0/management/oauth-callback`

100+ 账号挨个手点没法做，这扩展就是把这一整套自动化掉，包括：
- 自动清 cookie 避免 session 残留导致跳过登录页
- 自动去 2925 邮箱接收 OpenAI 二次验证码
- 自动识别「代码不正确」并用新邮件的码重试
- 验证完一封邮箱后自动清理 2925 上的验证码邮件

## 安装

1. Chrome 打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选这个目录（`CpaReauthHelper/`）
4. 点 Chrome 工具栏的扩展图标 → 侧栏会弹出

## 用法

### 1. 配置 CPA

在侧栏「1. CPA 配置」填：

- **CPA 地址**：你的 CPA 实例首页，如 `https://cpa.example.com`
- **管理密钥**：CPA 的管理 Bearer Token
- **账号统一密码**：所有目标邮箱的统一登录密码
- **回调方式**：默认「本地拦截 localhost:1455 回调」

点「测试连通性」校验。会同时显示总账号数 / codex 账号数 / 待重授权账号数。

### 2. 选邮箱来源

两种模式：

- **自动**：点「从 CPA 拉取待重新授权的邮箱」→ 会调 `GET /v0/management/auth-files` 把 `provider=codex && unavailable=true` 的邮箱拉过来。
- **手动**：在 textarea 里粘邮箱（一行一个 / 逗号分号都行），点「载入这批邮箱」。

两种模式可在「2. 邮箱来源」处切换。

### 3. （可选）登录 2925 邮箱

如果你的目标邮箱是 duck.com 别名并转发到 [2925.com](https://www.2925.com/) 收件箱，**提前登录一次 2925**。OpenAI 偶发会要求邮箱二次验证码，扩展会自动打开 2925 接码。未登录的话只能等超时。

### 4. 跑

点「开始 / 继续」。扩展会：

- 串行处理每个 `pending` 邮箱
- 自动打开/复用一个标签页跑完整 OAuth（邮箱页 → 密码页 → 可选邮箱验证码 → OAuth 同意 → localhost 回调）
- 任意时刻可点「停止」（当前邮箱跑完后退出）
- 整批跑完后，失败的可一键「重试失败」
- 列表里每行右侧 🗑 可单独移除某个邮箱（运行中不允许删）

成功 = `POST /v0/management/oauth-callback` 返 200。CPA 下次 refresh 自然会把 `unavailable` 标为 false。

### 5. 中断恢复

设置 + 进度都存在 `chrome.storage.local`，浏览器关掉重开能接着跑。要重头来点「清空进度」。

按钮卡住时可用「🔓 强制解锁」逃生口重置 Service Worker 残留的运行标志。

## 关键设计点

### 邮箱二次验证：自动接码 + 防错码

很多 duck.com 邮箱在 OAuth 流程里会被 OpenAI 要求二次验证（进入 `auth.openai.com/email-verification` 页）。扩展会：

1. 打开 2925 收件箱标签页
2. 后台轮询（每 ~3s 一次）扫描 inbox，识别同时含 **品牌词（ChatGPT/OpenAI）** 且 **code 关键字**（code/验证码/temporary login）的邮件 —— **拒绝匹配「ChatGPT 给你的一些实用点子」之类的营销邮件**
3. **未读邮件优先**（最新到达的）；同账号多封时永远先用最新一封
4. 提取 6 位数验证码（强匹配「验证码 + 6 位数」优先；弱匹配「OpenAI 邮件预览里第一个独立 6 位数」兜底）
5. 切回 OpenAI tab 填码
6. **如果 OpenAI 页面回显「代码不正确 / Invalid code」**，自动加进 skipCodes 黑名单，回 2925 拉一封更新的码重试，最多 3 轮

### 永不误点「重新发送电子邮件」

`重新发送 / Resend / send another` 类按钮被显式排除在「继续」按钮匹配之外 —— 点它会作废 2925 上刚拿到的所有有效码，是这类自动化最容易踩的坑。

### 验证完即删 2925 邮件

每个邮箱整体成功（CPA POST 200）后，扩展会自动登录 2925 把本轮用过的所有验证码邮件（含被拒绝的旧码）删掉，避免下一封邮箱在同一收件箱里被旧邮件干扰。失败不阻塞主流程（best-effort）。

### Background tab 限流

Chrome 会对后台 tab 限流（rAF / setTimeout / webNavigation 投递）。2925 Vue 应用刷新邮件列表、OAuth 跳转到 localhost 都依赖正常事件循环，所以扩展在关键步骤前会主动 `chrome.tabs.update(tabId, { active: true })` 把目标 tab 调到前台。代价是用户会看到 tab 在前后台切，但这场景下用户本来就不该在用浏览器。

### Localhost 回调监听

`chrome.webNavigation.onBeforeNavigate` 在 tab 打开瞬间就注册（防止某些场景 OAuth 自动跳过同意页直接跳 localhost），但**超时计时只在「OAuth 同意按钮点完」之后启动**，避免被前面的 2925 接码慢步骤拖垮。

## 架构

```
manifest.json                    MV3 manifest（sidePanel / webNavigation / scripting / cookies）
background.js                    Service Worker 入口（importScripts 装载所有模块）
background/
  cpa-api.js                     CPA 接口封装（auth-files / codex-auth-url / oauth-callback / ping）
  state.js                       全局状态（settings / progress / running / logs，三块独立存储）
  cookie-cleanup.js              每封邮箱前清 OpenAI/ChatGPT cookies
  auth-flow-runner.js            单邮箱完整 OAuth 流程（开 tab、驱动 content、接码、拦回调、上报、清邮件）
  batch-runner.js                批量调度 + 失败列表 + 串行 + 冷却
  message-router.js              sidebar ↔ background 消息总入口
content/
  openai-auth.js                 注入 auth.openai.com 等，识别 email/password/email_verification/oauth_consent + 自动填表
  mail-2925.js                   注入 2925.com，扫 inbox / 拉验证码 / 按 code 值删邮件
sidepanel/
  sidepanel.html / .css / .js    侧栏 UI（配置 / 来源 / 批量 / 实时日志 / 邮箱列表带删除按钮）
shared/
  constants.js                   项目级共享常量（CPA_MSG 消息 type、状态枚举、存储 key、超时常量）
tests/
  mail-2925.test.js              纯函数单元测试
icons/                           16/48/128
```

### 三块状态存储

| 存储 | 用途 | 何时清 |
|---|---|---|
| `chrome.storage.local` → `cpa_settings` | CPA URL / 管理密钥 / 共享密码 / 来源 / 手动邮箱 | 用户主动改 |
| `chrome.storage.local` → `cpa_batch_progress` | 邮箱列表 + 各邮箱状态 | 「清空进度」/ 单条「移除」 |
| `chrome.storage.session` → `cpa_batch_running` + `cpa_recent_logs` | 当前轮临时态 + 实时日志 | SW 重启 / 「停止」/「强制解锁」 |

### 消息流（关键路径）

```
sidebar ──CPA_START_BATCH──▶ message-router ──▶ batch-runner.startBatch()
                                                      │
                                                      ▼
                                         循环: reauthSingleEmail(email)
                                                      │
        ┌─────────────────────────────────────────────┼────────────────────────────────────┐
        │                                             │                                    │
        ▼                                             ▼                                    ▼
  cookie-cleanup                            ensureAuthTab + content                ensureMail2925Tab
  clear OpenAI cookies                      EXECUTE_FILL_EMAIL                     INSPECT_2925_INBOX (probe)
                                            EXECUTE_FILL_PASSWORD                  FETCH_2925_CODE × N (3s/次)
                                            EXECUTE_FILL_VERIFICATION_CODE ──┐     DELETE_2925_MAIL (收尾)
                                            EXECUTE_CONFIRM_OAUTH            │
                                                                             │
                                                       ┌─────────────────────┘
                                                       ▼
                                            waitForPostCodeSubmit
                                            (oauth_consent? 还是 email_verification + hasError?)
                                                       │
                                                       ▼
                                            webNavigation.onBeforeNavigate
                                            拦截 localhost:1455/auth/callback?code=...&state=...
                                                       │
                                                       ▼
                                            CPA POST /v0/management/oauth-callback
                                                       │
                                                       ▼
                                            (best-effort) DELETE_2925_MAIL 清掉用过的验证码邮件
```

## 与 FlowPilot 主项目的关系

本项目是 [FlowPilot](https://github.com/LiveAckerman/FlowPilotPro) 主项目的**精简子集**，专注于「重新授权」单一场景：

- 不做注册、不做手机号、不做 Plus、不做 GoPay、不做接码以外的 provider
- 只用 password 登录（不支持 Google/Apple OAuth）
- 单一回调方式：localhost 拦截 + POST 上报（FlowPilot 主项目还有 hostedCheckout 等其他模式）

两者可以共存安装，互不影响。

## 测试

```bash
npm test
```

测试是基于 `node:test` 的纯函数 / 模块单测，不启动浏览器。覆盖：

- 验证码正则提取（强匹配 / 弱匹配 / 长数字串避让）
- 营销邮件过滤（chatgpt + code 双关键字）
- 收件人邮箱匹配
- 未读邮件检测

## 常见问题

**Q: 一直卡在「等 localhost 回调超时」？**
A: 检查 CPA 配置里的回调端口（默认 1455 = CPA 仓库 `codexCallbackPort`）。OAuth 同意页点完后会跳到 `localhost:1455/...`，扩展拦截这个跳转抓 code/state。监听器在 OAuth tab 打开瞬间就注册了，**超时计时只在同意按钮点完之后启动**，所以前面 2925 接码慢一点没关系。

**Q: 邮箱二次验证码总抓不到？**
A: 确保提前登录 2925；并且 duck.com 那边转发开关是开的。日志会打「2925 第 N 次轮询：扫描 X 封 / OpenAI 验证码邮件 Y 封（未读 Z）/ GPT 营销邮件 W 封」，可以据此判断是邮件没到还是过滤没命中。

**Q: 报「代码不正确」？**
A: 通常是 2925 同时收到多封验证码邮件，OpenAI 只认最新一封。扩展已经会自动把试过的码加进 skipCodes 黑名单，回 2925 拉新邮件重试 3 次。如果 3 次都失败，要么是密码错了，要么是该账号被 OpenAI 风控了。

**Q: 按钮卡住点不动？**
A: SW 死了导致 `running.isRunning` 残留为 true。点「🔓 强制解锁」逃生按钮。

## License

MIT
