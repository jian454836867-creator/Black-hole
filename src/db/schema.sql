-- OpenClaw Mini 本地黑盒知识库 — 5 张核心表
-- 1. 原始素材表 (不可变，溯源用)
CREATE TABLE IF NOT EXISTS raw_files (
    id TEXT PRIMARY KEY,
    privacy_level TEXT DEFAULT 'private', -- 'private' | 'normal'
    file_type TEXT,          -- 'text', 'web', 'image'
    source_url TEXT,
    raw_text TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- 2. 观点/洞见表 (核心节点)
CREATE TABLE IF NOT EXISTS insights (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,   -- 核心观点
    summary TEXT,
    tags TEXT,               -- JSON Array
    source_file_id TEXT,
    source_url TEXT,         -- 出处链接（微信发文章链接时记录）
    archived INTEGER DEFAULT 0,  -- 1=已归档（被更新版本替代，不参与检索）
    archived_reason TEXT,    -- 归档原因（被哪条替代）
    status TEXT DEFAULT 'active',     -- active | superseded | conflicted | corrected
    valid_from TEXT,                  -- 生效起始（ISO 日期或空）
    valid_to TEXT,                    -- 失效时间（ISO 日期或空）
    relation_group_id TEXT,           -- 关系组 ID（折叠/版本/冲突共享）
    conflict_flag INTEGER DEFAULT 0,  -- 1=有冲突标记
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- 3. 关系表 (claim 级 8 类判定结果)
-- relation_type: EQUIVALENT | CONTAINS | VERSION | CONTRADICTS | PSEUDO_CONFLICT | OVERLAPS | RELATED | UNRELATED
-- 兼容旧值: 'merge' → EQUIVALENT, 'conflict' → CONTRADICTS
CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    insight_a_id TEXT NOT NULL,
    insight_b_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    subtype TEXT,               -- exact | paraphrase | alias | specialization | condition_conflict | unit_conflict | granularity_conflict | source_conflict
    confidence REAL DEFAULT 0.8,
    evidence TEXT,              -- JSON: ["原文片段A", "原文片段B"]
    explanation TEXT,
    user_confirmed INTEGER DEFAULT 0, -- 0: 待确认, 1: 已收录, -1: 已忽略
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- 3b. claim 结构化抽取缓存（每条 insight 抽出的 claim 列表）
CREATE TABLE IF NOT EXISTS claims (
    insight_id TEXT NOT NULL,
    subject TEXT,
    slot TEXT,
    value TEXT,
    polarity INTEGER DEFAULT 1,
    valid_from TEXT,
    valid_to TEXT,
    source TEXT,
    confidence REAL DEFAULT 1.0,
    text_span TEXT,
    PRIMARY KEY (insight_id, subject, slot, value)
);

-- 4. 向量虚拟表 (语义检索, 512 维 bge-small-zh-v1.5)
-- 注意：vec0 表的 rowid 即 insight_ids.rowid 的映射键，不能额外声明 INTEGER PRIMARY KEY 列
CREATE VIRTUAL TABLE IF NOT EXISTS vec_insights USING vec0(
    embedding float[512]
);

-- 6. 文章表（微信发链接时整篇存储，与短句 insights 分离）
CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,              -- 出处链接
    title TEXT,                     -- 文章标题（从 <title> 或首行提取）
    content TEXT,                   -- 全文正文
    summary TEXT,                   -- 一句话摘要（DeepSeek 生成）
    topic_tags TEXT,                -- JSON Array 主题标签
    privacy_level TEXT DEFAULT 'private',
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- 7. 文章向量映射（article_id → vec_articles rowid）
CREATE TABLE IF NOT EXISTS article_ids (
    rowid INTEGER PRIMARY KEY,
    article_id TEXT NOT NULL UNIQUE
);

-- 8. 文章向量虚拟表（文章级语义检索）
CREATE VIRTUAL TABLE IF NOT EXISTS vec_articles USING vec0(
    embedding float[512]
);

-- 9. 文章关系表（文章间碰撞：同主题 → 合成新文章）
CREATE TABLE IF NOT EXISTS article_relations (
    id TEXT PRIMARY KEY,
    article_a_id TEXT NOT NULL,
    article_b_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,    -- 'same_topic' | 'contradict'
    overlap TEXT,                   -- 重叠主题描述
    merged_article_id TEXT,         -- 合成后的新文章 ID
    user_confirmed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- 5. 全文检索虚拟表 (BM25 关键词检索)
CREATE VIRTUAL TABLE IF NOT EXISTS fts_insights USING fts5(
    insight_id,
    content,
    tags,
    tokenize='unicode61'
);

-- 辅助：insight_id 映射表（vec 主键用 INTEGER，映射回 TEXT id）
CREATE TABLE IF NOT EXISTS insight_ids (
    rowid INTEGER PRIMARY KEY,
    insight_id TEXT NOT NULL UNIQUE
);

-- FTS 同步触发器（重建虚拟表时由 resetAll 重建）
CREATE TRIGGER IF NOT EXISTS ai_insights_ai AFTER INSERT ON insights BEGIN
    INSERT INTO fts_insights(insight_id, content, tags)
    VALUES (new.id, new.content, COALESCE(new.tags, ''));
END;
CREATE TRIGGER IF NOT EXISTS ai_insights_ad AFTER DELETE ON insights BEGIN
    INSERT INTO fts_insights(fts_insights, insight_id, content, tags)
    VALUES ('delete', old.id, old.content, COALESCE(old.tags, ''));
END;

