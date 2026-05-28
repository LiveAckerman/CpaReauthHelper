# CLAUDE.md

This file gives Claude Code (claude.ai/code) context when working on **CpaReauthHelper**.

## 项目概述

CPA Reauth Helper 是 Manifest V3 Chrome 侧栏扩展，用途单一：**批量给 CPA (CLIProxyAPI) 里 codex 失效账号自动做 OAuth 重新授权**。

它是 FlowPilot 主项目（`../FlowPilot-FlowPilot-billy`）的精简子集——只复用了 OpenAI auth 页面识别 + localhost 回调拦截 的核心思路，不包含注册 / 手机号 / Plus / GoPay / 接码 / 邮件 provider 等任何模块。

## 三步流程（每个邮箱）

```
GET  /v0/management/codex-auth-url        → 拿 OAuth URL
打开 OAuth URL → 自动填邮箱 → 自动填密码 → 点 OAuth 同意
拦截 localhost:1455/auth/callback?code=...&state=...
POST /v0/management/oauth-callback (provider:codex, redirect_url:<拦到的URL>) → 200 = 成功
```

## 架构边界

- **`shared/`**：跨 background + content + sidepanel 共享的常量（消息 type 字符串、状态枚举、超时常量、存储 key）。**新增任何跨上下文都用的常量必须放这里**，不要在 background 一份 sidepanel 一份。
- **`background/`**：Service Worker 跑的所有逻辑。各文件用 IIFE + `__CPA_REAUTH_X_BOOTED` 守卫避免重复加载冲突，通过 `self.CpaReauthX` 互相调用。
- **`content/openai-auth.js`**：注入到 `auth.openai.com / accounts.openai.com / chatgpt.com` 的页面识别 + 自动填表。**只识别 3 种页面**：email_entry / password / oauth_consent。其他状态返回 `unknown`，由 background 决定如何处理。
- **`sidepanel/`**：纯 UI 层，不直接调 chrome 存储；所有数据通过消息（`CPA_*`）问 background 拿。

## 关键文件

- [shared/constants.js](shared/constants.js) — 项目级常量；改这里前看下被哪些文件依赖
- [background/cpa-api.js](background/cpa-api.js) — CPA 3 个端点 + ping
- [background/state.js](background/state.js) — settings/progress/running 三块存储 + entries CRUD
- [background/auth-flow-runner.js](background/auth-flow-runner.js) — 单邮箱完整 OAuth 流程
- [background/batch-runner.js](background/batch-runner.js) — 批量串行 + 失败列表
- [content/openai-auth.js](content/openai-auth.js) — 页面识别 + 填表

## 进度 / 状态分层

- `chrome.storage.local: cpa_settings`        — CPA 配置 (url/key/password/source/manualText)
- `chrome.storage.local: cpa_batch_progress`  — 邮箱条目数组 + 各自 status（中断恢复）
- `chrome.storage.session: cpa_batch_running` — 当前是否在跑、当前邮箱、当前 step、最近 200 条日志

## 常见命令

```bash
# 跑全部单测
npm test

# 静态语法检查改动文件（提交前推荐）
node --check path/to/file.js
```

## 提交规范

- 中文 commit message（与 FlowPilot 主项目一致）
- 不要 `git add -A`，按文件 add，避免误提交临时文件
- 不要 amend 已有 commit，新增 commit
- 改动结构 / 链路要同步更新 README.md
