// 生成 20 条模拟 insights（含专名/领域术语），入库并同步 vec + fts
import { insertInsight, attachVector, resetAll } from '../src/db/repo.js';
import { embedder } from '../src/model/embedder.js';
import { getDb } from '../src/db/db.js';

const DATA = [
  { content: '苏轼被贬黄州时写下《赤壁赋》，在困顿中寻求精神超脱', tags: ['苏轼', '黄州', '宋代文学'], summary: '苏轼黄州时期的精神世界' },
  { content: '苏轼的「一蓑烟雨任平生」体现其豁达的人生态度', tags: ['苏轼', '豁达', '人生态度'], summary: '苏轼的豁达哲学' },
  { content: '量子纠缠是量子力学中粒子间非局域关联现象', tags: ['量子纠缠', '量子力学', '物理'], summary: '量子纠缠基本概念' },
  { content: '微服务架构将单体拆分为独立部署的服务，提升弹性但增加运维复杂度', tags: ['微服务', '架构', '分布式'], summary: '微服务拆分的利弊' },
  { content: '微服务拆分的代价是分布式事务与网络调用的复杂性', tags: ['微服务', '分布式事务', '代价'], summary: '微服务的隐性成本' },
  { content: '交易中的止损是控制风险的核心手段，截断亏损让利润奔跑', tags: ['止损', '交易', '风险管理'], summary: '止损原则' },
  { content: '长期价值投资者认为频繁止损会破坏复利效应', tags: ['长期投资', '复利', '持有'], summary: '长期持有与止损的张力' },
  { content: '不要为打翻的牛奶哭泣，沉没成本不应影响当前决策', tags: ['沉没成本', '决策', '心理'], summary: '沉没成本谬误' },
  { content: '沉没成本谬误让人执着于已投入但无法收回的资源', tags: ['沉没成本', '行为经济学'], summary: '行为经济学视角' },
  { content: '复利效应是长期投资回报的核心来源，时间是最强的朋友', tags: ['复利', '投资', '时间'], summary: '复利的力量' },
  { content: '巴甫洛夫条件反射说明行为可由环境刺激塑造', tags: ['条件反射', '心理学', '巴甫洛夫'], summary: '条件反射原理' },
  { content: '墨家主张兼爱非攻，与儒家仁爱形成思想对照', tags: ['墨家', '兼爱', '非攻'], summary: '墨家核心思想' },
  { content: '道家的无为而治强调顺应自然规律而非强行干预', tags: ['道家', '无为', '治理'], summary: '无为而治' },
  { content: 'Kubernetes 通过声明式 API 管理容器编排，降低运维负担', tags: ['Kubernetes', '容器', '编排'], summary: 'K8s 声明式管理' },
  { content: '声明式 API 的设计哲学是描述目标状态而非操作过程', tags: ['声明式', 'API 设计'], summary: '声明式设计哲学' },
  { content: '海明威的冰山理论主张只呈现八分之一，其余隐含', tags: ['海明威', '冰山理论', '写作'], summary: '冰山理论' },
  { content: '留白是东方美学的核心，以无胜有营造想象空间', tags: ['留白', '东方美学'], summary: '留白美学' },
  { content: '概率思维要求用期望值而非单次结果评估决策', tags: ['概率思维', '决策', '期望值'], summary: '概率决策框架' },
  { content: '过度自信偏差使人系统性高估自身判断的准确性', tags: ['过度自信', '认知偏差'], summary: '过度自信偏差' },
  { content: '苏轼《江城子》悼念亡妻，「十年生死两茫茫」是千古悼亡绝唱', tags: ['苏轼', '江城子', '悼亡'], summary: '苏轼悼亡词' },
];

console.log('reset DB...');
resetAll();

console.log('warming up model (first run downloads ~24MB)...');
await embedder.warmup();
console.log('model ready, embedding 20 insights...');

const t0 = Date.now();
for (const item of DATA) {
  const { id } = insertInsight(item);
  const [vec] = await embedder.embed([item.content]);
  attachVector(id, vec);
}
const n = getDb().prepare('SELECT COUNT(*) n FROM insights').get().n;
console.log(`seeded ${n} insights in ${Date.now() - t0}ms`);
embedder.stop();
