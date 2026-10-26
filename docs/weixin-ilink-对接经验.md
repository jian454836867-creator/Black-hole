# OpenClaw 飞书 / 微信对接经验总结

> 项目：openclaw-mini（自建 mini OpenClaw，不依赖本地 OpenClaw Gateway，直连 DeepSeek）
> 时间：2026-10-25
> 结论：飞书长连接、微信 iLink 协议均跑通端到端对话。客户端 exe 因环境限制未完成，经验沉淀如下。

\---

## 一、整体架构

```
config.json (llm + feishu + weixin 配置)
        │
        ▼
   MiniAgent (src/agent/loop.js)  ← 工具循环 + DeepSeek 直连
        │
   ┌────┼─────────────────┐
   ▼    ▼                 ▼
FeishuBridge  WeixinBridge  WeChatBridge   ← 各渠道独立会话
(长连接)    (iLink长连接)   (小程序WS)
```

**核心原则**：

* `llm.backend` 固定 `"openai"`（直连 DeepSeek API，不走 Gateway）
* 每个渠道独立 `sessionKey`（`feishu:<user>` / `weixin:<user>` / `client:main`），用哪个回哪个，互不串话
* 渠道桥只负责"收消息 → 调 agent → 回消息"，不碰 LLM 逻辑

\---

## 二、飞书对接（长连接模式）

### 1\. 配置

* 飞书开放平台建**自建应用**，拿 `appId` + `appSecret`
* 开通**机器人**能力 + **消息**相关权限（`im:message` 收发消息）
* 用**长连接模式**（不用配回调 URL，适合无公网 IP 的场景）

### 2\. 关键技术点

* **长连接**：飞书 SDK 的 WebSocket 长连接，SDK 自动维护
* **踩坑**：飞书 SDK 的回复/patch 接口有 bug → 改用**原始 REST API** 直接回复

  * 回复消息：`POST /open-apis/im/v1/messages/:message\_id/reply`
  * 更新消息（流式）：`PATCH /open-apis/im/v1/messages/:message\_id`
* **token**：`POST /open-apis/auth/v3/tenant\_access\_token/internal` 拿 tenant\_access\_token，定期刷新
* **流式输出**：先发占位消息，再 PATCH 更新内容（打字机效果）

### 3\. 会话

* 消息带 `open\_id`（用户）+ `chat\_id`（会话）
* sessionKey 用 `feishu:<open\_id>` 隔离

飞书的key

App ID：cli\_aa5721db3ff9dbb0

App Secret：xWKeLtjhozELSnpzYhf0SfuUaIZJAW3W





\---



\---

## 四、Agent 与工具

### MiniAgent (src/agent/loop.js)

* 工具循环：用户消息 → LLM 决定是否调工具 → 执行 → 结果回 LLM → 直到给出最终回复
* 配置：`baseUrl` / `apiKey` / `model` / `backend` / `maxToolRounds`
* 流式：delta 回调（打字机效果）

### 内置工具 (src/tools/)

|工具|作用|
|-|-|
|time|当前时间|
|search|联网搜索|
|fetch|抓取网页|
|shell|执行命令|
|file\_read/write/list|工作区文件读写|
|notes|记笔记|

\---

## 五、客户端封装经验（exe 踩坑）

### 目标

双击 exe → 自动连 → 能对话；首次配置飞书/微信；用哪个渠道回哪个。

### 尝试过的方案与结果

|方案|结果|原因|
|-|-|-|
|Electron 45|静默退出|淘宝镜像 zip 不完整 + 无头会话|
|Electron 31|静默退出|同上（官方 zip 也缺 chrome\_elf.dll，但非必需）|
|WebView2 原生 exe|失败|缺 `WebView2Loader.dll`（补上后）→ WebView2 运行时不可用（RuntimeNotFound）|
|独立 Chromium (Chrome for Testing)|崩溃 E\_FAIL|有头窗口创建失败（无头会话限制）|
|Edge `--app` 模式|空白/不显示|独立 profile 首次渲染空白；默认 profile 加入现有实例不显示|
|**浏览器标签页**|✅ 成功|复用系统 Edge，100% 能渲染|

### 关键经验

1. **ESM import Windows 绝对路径** 必须 `pathToFileURL(p).href`，否则 `ERR\_UNSUPPORTED\_ESM\_URL\_SCHEME`（exe 静默退出主因之一）
2. **无头会话 vs 交互式桌面**：AI 会话（DSH）启动的 GUI 进程，窗口弹不到用户物理屏幕。exe 必须**用户自己双击**才能在桌面弹出。
3. **WebView2 三件套**：`Microsoft.Web.WebView2.Core.dll`（.NET 封装）+ `WebView2Loader.dll`（**原生加载器，必须和 exe 同级**）+ 系统 WebView2 运行时（Win10/11 预装 Edge）
4. **C# 编译 exe**：`csc.exe /target:winexe /platform:x64`，WPF 需引用 `WindowsBase/PresentationCore/PresentationFramework`（在 `Framework64\\v4.0.30319\\WPF\\`），主线程加 `\[STAThread]`
5. **VC++ 运行库**：Electron/Chromium 依赖，缺了 exe 静默退出。装 VC++ 2015-2022 x64
6. **未签名 exe** 触发 SmartScreen → 点"仍要运行"，或买代码签名证书用 signtool 签

### 后端启动模式（exe 内嵌）

```
exe 启动 → Process.Start(node client-server.js) → 等 /api/health 就绪 → 开浏览器/窗口
```

* 就绪判定用**真正 GET /api/health**（不是只测 TCP 端口），否则页面加载到空端口 → 空白
* 后端保活在 exe 进程，窗口关闭则杀后端

\---

## 六、配置样例 (config.json)

```json
{
  "llm": {
    "backend": "openai",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-v4-flash",
    "apiKey": "sk-xxx"
  },
  "feishu": {
    "enabled": true,
    "appId": "cli\_xxx",
    "appSecret": "xxx",
    "domain": "feishu"
  },
  "weixin": {
    "enabled": true,
    "accounts": {
      "2db2ae01df61@im.bot": {
        "botId": "2db2ae01df61@im.bot",
        "token": "xxx",
        "loggedInAt": "..."
      }
    }
  }
}
```

\---

## 七、可复用要点（快速重建）

1. **agent 核心**（loop.js + tools/）可直接复用，渠道无关
2. **飞书桥**：原始 REST reply/patch + 长连接 SDK
3. **微信桥**：iLink HTTP 长轮询 + uint64 无损解析 + 扫码登录
4. **会话隔离**：sessionKey 按渠道 + 用户
5. **配置热加载**：改 config.json 后重启桥即可，不用重启整个程序
6. **流式输出**：delta 回调 + 渠道的 PATCH/更新消息接口

## 八、未解决 / 遗留

* 客户端独立窗口 exe：受 DSH 无头会话限制，AI 侧无法验证窗口弹出。用户本机双击 Electron exe 应能弹出（官方完整包），但未最终确认。
* 微信小程序 WS "连接中" 1006：诊断已就位，待用户控制台输出。
* 多渠道独占：飞书 appId / 微信 bot 各自独占长连接，多实例互斥。

