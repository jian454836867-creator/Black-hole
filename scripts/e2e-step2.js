// E2E 验收脚本：文本入库 → 提问 → 验证带引用回答
const base = 'http://127.0.0.1:7700';

const text = `沉没成本谬误：人们在做决策时常常被已经投入且无法收回的成本所影响。一个经典例子是泰坦尼克号，尽管已经注定沉没，人们仍然试图拯救它。正确的做法是像对待打翻的牛奶一样，不再为无法改变的事情投入资源。经济学建议决策只看边际收益与边际成本，历史投入不应进入决策函数。`;

(async () => {
  // 1) 入库
  const r1 = await fetch(base + '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, privacyLevel: 'normal', sourceUrl: 'local-test' }),
  });
  const j1 = await r1.json();
  console.log('[1] ingest:', JSON.stringify({
    ok: r1.ok,
    fileId: j1.fileId?.slice(0, 8),
    usedLlm: j1.usedLlm,
    insights: j1.insights?.map(i => i.content.slice(0, 30)),
  }));

  await new Promise(r => setTimeout(r, 3000)); // 等异步向量化

  // 2) 时间线
  const r3 = await fetch(base + '/timeline?limit=30');
  const j3 = await r3.json();
  console.log('[2] timeline: 共', j3.items.length, '条（seed 20 + 新入库）');

  // 3) 提问（无 API Key 时走本地降级，回答应含 ⚠️ 未触网 标注）
  const t0 = Date.now();
  const r2 = await fetch(base + '/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '沉没成本应该怎么处理？', k: 3 }),
  });
  const j2 = await r2.json();
  console.log('[3] ask:', JSON.stringify({
    ok: r2.ok,
    latencyMs: Date.now() - t0,
    localOnly: j2.localOnly,
    citations: j2.citations?.map(c => c.content.slice(0, 25)),
  }, null, 1));
  console.log('   answer:', (j2.answer || '').slice(0, 300));

  // 4) 断言：有引用 + 有回答 + 降级标注正确
  const hasCitation = (j2.citations || []).length > 0;
  const hasAnswer = (j2.answer || '').length > 10;
  const marked = !j2.localOnly || (j2.answer || '').includes('未触网');
  const pass = r2.ok && hasCitation && hasAnswer && marked;
  console.log(pass ? '\n✅ STEP 2 后端流验收通过（入库→向量化→召回→带引用回答+隐私标注）' : '\n❌ 验收未通过');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('E2E FAIL', e); process.exit(1); });
