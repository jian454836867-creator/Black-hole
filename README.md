# Black hole

**本地黑盒知识库** —— 投喂 + 提问。数据不出本机，AI 在后台静默消化，
发现跨时间的观点碰撞。

> 名字来自它的工作方式：东西丢进去看不见，但会一直消化、一直碰撞，
> 直到你需要的时候，答案自己浮出来。

---

## 它解决什么问题

笔记软件让你**存**东西，搜索引擎让你**找**关键词。
但真正麻烦的是：**后来看到的信息和以前看到的矛盾了，你不知道。**

Black hole 在每次入库时做关系判定 —— 是重复？是补充？是新版本？还是真矛盾？
—— 并把结论沉淀成关系边。检索时按关系聚合，而不是把一堆相似句子平铺给你。

---

## 快速开始

### 环境要求

- Node.js ≥ 20
- Windows（启动器是 `.vbs`；Linux/macOS 手动起服务即可）

### 三步跑起来

```powershell
# 1. 装依赖
npm install
cd gui && npm install && cd ..

# 2. 配环境变量（可跳过，不配也能跑）
copy .env.example .env
#   想用 AI 提取观点和生成回答 → 填 DEEPSEEK_API_KEY
#   不填 → 降级为本地模式：按句入库 + 词条直出（标注「未触网」）

# 3. 构建前端 + 启动
cd gui && npm run build && cd ..
```

然后双击 **`start.vbs`**（无任何黑框），或手动：

```powershell
node src/server/api.js       # 后端 :7700
node src/server/static.js    # 前端 :5173（伺服 gui/dist）
```

Edge 应用窗口会打开 `http://127.0.0.1:5173`。

> **改了前端代码**要重新 `cd gui && npm run build`，再刷新窗口。

---

## 怎么用

### GUI

- **上区 60%**：回答区（🔍 线索浮现）+ 碰撞时间线
- **下区 40%**：统一输入框
  - 输入文字 → 点 **🔍 线索浮现** = 提问
  - 输入文字 → 点 **✨ 灵感汇入** = 入库
  - 拖文件进窗口 = 入库（.txt / .md / .html）
  - 右下角 **可触网 / 不触网** 切换隐私级别
- **右上角 ⚙️ 设置**：DeepSeek Key、微信扫码、清空数据库
- **碰撞卡片**：块内直接 **✓收录 / ✕忽略**

### 微信

扫码绑定后（设置页 → 生成二维码）：

| 发什么 | 效果 |
|---|---|
| 直接发文字 | 入库，回「👌 已入库」 |
| `问xxx` | 向知识库提问，回答案 + 引用（带出处链接） |
| 发 URL | 抓正文整篇存为文章，回「👌 已收录 域名：标题」 |
| `/clear` | 清空数据库 |

每天 20:00 推送当天新增的碰撞汇总。

---

## 架构

```
                    ┌─────────────┐
   微信 iLink ──────▶│             │
                    │  ingest     │──▶ 价值过滤 ──▶ 观点提取
   GUI / HTTP ──────▶│  pipeline   │                      │
                    └─────────────┘                      ▼
                                                  insight 入库
                                                         │
                                    ┌────────────────────┘
                                    ▼
                            向量化（bge-small-zh 512d）
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │  claim 级关系判定              │
                    │  召回 top-20 → claim 对齐      │
                    │  → 8 类短路判定 → 写关系边     │
                    └───────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
   提问 ────────────▶│  双路检索（向量 ∥ FTS5）        │──▶ 关系聚合 ──▶ LLM 回答
                    └───────────────────────────────┘
```

### 目录

```
├── src/
│   ├── db/            schema.sql / db.js（迁移）/ repo.js（CRUD）
│   ├── model/         bge-small-zh ONNX，worker_threads 隔离推理
│   ├── pipeline/      filter 价值过滤 / llm DeepSeek 客户端 / ingest 入库 / rag 问答
│   ├── rel/           claims 抽取 / align 对齐 / classify 8 类判定  ★核心
│   ├── search/        双路检索 + 关系聚合 / 文章级检索
│   ├── synth/         comparator 条目碰撞 / article-comparator 文章碰撞
│   ├── server/        api.js  HTTP :7700  / static.js 静态伺服 :5173
│   └── bridges/       weixin.js iLink 长连接
├── gui/               Vue 3 + Vite 前端
├── scripts/           验收与冒烟脚本
├── docs/              需求 / 计划 / 进展 / 设计方案
├── start.vbs          Windows 静默启动器
└── CHANGELOG.md       版本日志
```

---

## 8 类关系

入库时对每条新内容做关系判定，结果写进 `relations` 表：

| 类型 | 判据 | 后续动作 |
|---|---|---|
| `EQUIVALENT` | 语义等价，claim 无冲突 | 折叠，只留一条 |
| `CONTAINS` | 一方的 claim 是另一方子集 | 被包含方逻辑失效 |
| `OVERLAPS` | 部分重叠，各有独有信息 | 建组，聚合成互补 |
| `CONTRADICTS` | 同槽位值冲突，差异无法解释 | 双方共存，标冲突待人工裁决 |
| `PSEUDO_CONFLICT` | 看似冲突，条件/口径/来源不同 | 按来源分组，不当矛盾报 |
| `VERSION` | 同槽位不同值，时间区间不重叠 | 旧版逻辑失效，保留历史 |
| `RELATED` | 共享实体，主题相关 | 仅召回不足时扩展 |
| `UNRELATED` | 以上都不满足 | 独立存在 |

**设计原则**：逻辑失效不物理删除。误判可回滚，历史链可追溯。

详见 [claim 关系判定方案](docs/claim-关系判定方案.md)。

---

## 配置

全部通过 `.env`（复制 `.env.example`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 空 | 不填走本地降级模式 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | |
| `DEEPSEEK_FLASH_MODEL` | `deepseek-flash` | V4.1 Flash，日常提取/问答 |
| `DEEPSEEK_PRO_MODEL` | `deepseek-v4-pro` | 仅深度提问用 |
| `CLAIM_EXTRACT` | 空（规则） | 设 `llm` 开 LLM claim 抽取，成本翻倍 |
| `HF_ENDPOINT` | 空 | 国内走 `https://hf-mirror.com` |
| `PORT` | `7700` | 后端端口 |

微信登录态存在 `config.json`（已 gitignore，**不要提交**）。

### 费用参考

每条入库 = 1 次 Flash 调用（观点提取）。按空闲时段 1 元/百万输入 token 算，
存 1000 条约几毛钱。

---

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查（含 llm 是否可用） |
| GET | `/config/check` | 配置状态 |
| POST | `/config/save` | 保存 DeepSeek Key 到 `.env` |
| POST | `/ingest` | 入库：JSON `{text, privacyLevel, sourceUrl}` 或 multipart |
| POST | `/ask` | 提问：`{question, deep, privacy, k}` → `{answer, citations}` |
| GET | `/timeline?limit=N` | 时间线（含每条的关系） |
| GET | `/articles` | 文章列表 |
| POST | `/relations/confirm` | 裁决：`{id, state}` state ∈ {0,1,-1} |
| POST | `/clear` | 清空数据库 |

---

## 开发

```powershell
npm run smoke:db                              # DB + vec0 + FTS5 冒烟
node scripts/smoke-relations.js               # 8 类判定逻辑自测（21 项断言）
node scripts/smoke-db-migration.js            # 迁移 + 模块加载
npm run verify:step1                          # 检索层验收
node scripts/e2e-step2.js                     # 入库→问答端到端（需先起 API）
```

---

## 已知限制

- 规则 claim 抽取只覆盖中文常见句式，复杂长句需开 `CLAIM_EXTRACT=llm`
- 阈值是经验值，未用标注集校准
- 桌面端是 Edge `--app` 窗口，不是独立 exe
- 微信桥需自行扫码，token 只存本地

---

## 文档

- [需求整理](docs/需求整理.md)
- [开发计划](docs/开发计划.md)
- [开发进展全记录](docs/开发进展全记录.md)
- [claim 关系判定方案](docs/claim-关系判定方案.md)
- [微信 iLink 对接经验](docs/weixin-ilink-对接经验.md)
- [更新日志](CHANGELOG.md)

---

## License

MIT
