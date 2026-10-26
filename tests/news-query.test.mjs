import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { WorkflowEngine } from '../server/workflows.mjs';

const TITLE = '"국민연금 개혁의 모든 것: 장기 재정과 세대별 영향 분석"';
const TOPIC = '무관한 경제 정책';
const TREND = '전혀 다른 연결 트렌드';
const KEYWORDS = '기금 운용, 수익률, 기금 운용';
const ARTICLE_URL = 'https://news.google.com/rss/articles/CBMiFixtureNps?oc=5&hl=ko';
const HEADLINE = '국민연금공단, “수익률 5%” & 기금 운용 - 검증일보';
const PUBLISHED_AT = 'Sun, 25 Oct 2026 01:23:45 GMT';
const SUMMARY = '국민연금공단이 기금 운용 현황을 설명했다.';
const EMPTY_RSS = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Google News</title></channel></rss>';

function rss(items) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>국민연금공단 - Google News</title>
<link>https://news.google.com/</link><language>ko</language>${items}</channel></rss>`;
}

const VERIFIED_ITEM = `<item>
<title>국민연금공단, “수익률 5%” &amp; 기금 운용 - 검증일보</title>
<link>https://news.google.com/rss/articles/CBMiFixtureNps?oc=5&amp;hl=ko</link>
<guid isPermaLink="false">CBMiFixtureNps</guid>
<pubDate>${PUBLISHED_AT}</pubDate>
<description><![CDATA[${SUMMARY}]]></description>
<source url="https://publisher.example">검증일보</source>
</item>`;

const UNVERIFIED_ITEMS = [
  '<item><title>출처 없는 기사</title><link>https://publisher.example/no-source</link></item>',
  '<item><link>https://publisher.example/no-headline</link><source>검증일보</source></item>',
  '<item><title>안전하지 않은 주소</title><link>javascript:alert(1)</link><source>검증일보</source></item>',
  '<item><title>로그인 정보가 포함된 주소</title><link>https://user:password@publisher.example/private</link><source>검증일보</source></item>',
].join('');

function newsGraph(config) {
  const order = ['trend', 'news', 'research', 'script', 'storyboard', 'generate', 'render', 'review', 'publish'];
  const nodes = order.map((type, index) => ({
    id: `${type}-original`, type, x: index * 100, y: 0,
    config: type === 'news' ? config
      : type === 'script' ? { agent: 'existing' }
      : type === 'generate' ? { model: 'fixture-image', prompt: 'Do not generate', sceneIndex: 0 }
      : type === 'publish' ? { platform: 'youtube', visibility: 'private' }
      : {},
  }));
  const edges = nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, source: nodes[index].id, target: node.id }));
  nodes.push({ id: 'news-unselected', type: 'news', x: 100, y: 100, config: { query: '절대 실행하지 않을 검색', source: 'google_news' } });
  edges.push({ id: 'edge-unselected', source: 'trend-original', target: 'news-unselected' });
  return { name: 'Exact Google News query contract', nodes, edges };
}

async function fixture(t, { config, expectedQuery, xml = rss(VERIFIED_ITEM), status = 200 }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-news-query-'));
  const store = new Store(dataDir);
  let workflows;
  t.after(async () => {
    workflows?.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const traffic = [];
  const forbidden = (operation) => async () => {
    traffic.push(operation);
    throw new Error(`Unexpected ${operation} traffic during source collection`);
  };
  const requests = [];
  workflows = new WorkflowEngine({
    store,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      assert.equal(url.origin, 'https://news.google.com', 'only the injected Google RSS boundary is allowed');
      assert.equal(url.pathname, '/rss/search');
      // Reproduce the live failure: adding unrelated words produces HTTP 200 with zero items.
      const body = url.searchParams.get('q') === expectedQuery ? xml : EMPTY_RSS;
      return new Response(body, { status, headers: { 'content-type': 'application/rss+xml; charset=utf-8' } });
    },
    fetchTrends: async () => ({ trends: [{ keyword: TREND, source: 'Fixture RSS', url: 'https://publisher.example/trend' }], sources: [] }),
    runAgent: forbidden('agent'),
    render: forbidden('render'),
    validateAssets: (scenes) => scenes,
    generations: {
      provider: { estimate: forbidden('generation estimate'), create: forbidden('generation create'), status: forbidden('generation status'), modelSchema: forbidden('generation schema') },
      start: forbidden('generation start'), get: forbidden('generation get'), wait: forbidden('generation wait'), apply: forbidden('generation apply'),
    },
    publication: { approve: forbidden('publication approve'), publish: forbidden('publication publish'), resume: forbidden('publication resume') },
  });
  const channel = store.list('channels')[0];
  const episode = store.create('episodes', {
    channelId: channel.id, title: TITLE, topic: TOPIC, status: 'draft', version: 1, format: '9:16',
    scenes: [{ id: 'saved-scene', title: '저장된 장면', text: '기존 원고', duration: 5, background: '#101010', kind: 'title', layout: 'center', narration: '' }],
  });
  const template = workflows.create(newsGraph(config));
  const workflow = workflows.copy(template.id, { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const execute = async (selectedStages = ['trend-original', 'news-original']) => {
    const started = workflows.start(workflow.id, episode.id, {
      selectedStages, startStage: 'trend-original', expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version,
    });
    // Wait on the persisted terminal condition, not a wall-clock delay or guessed provider duration.
    for (let turn = 0; turn < 100; turn++) {
      const run = store.get('workflowRuns', started.id);
      if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail('Injected source-only workflow did not reach a terminal state');
  };
  return { store, episode, workflow, requests, traffic, execute };
}

function assertSourceOnly(f, run, selectedStages) {
  assert.deepEqual(run.selectedStages, selectedStages);
  assert.deepEqual(run.nodeRuns.map((node) => node.nodeId).sort(), f.workflow.nodes.map((node) => node.id).sort());
  assert.deepEqual(run.workflowSnapshot.nodes.map((node) => node.id), f.workflow.nodes.map((node) => node.id));
  assert.equal(run.workflowId, f.workflow.id);
  assert.equal(run.episodeId, f.episode.id);
  assert.equal(run.workflowVersion, f.workflow.version);
  for (const node of run.nodeRuns.filter((node) => !selectedStages.includes(node.nodeId))) {
    assert.equal(node.status, 'skipped', `${node.nodeId} must remain outside the selected execution`);
    assert.equal(node.output, undefined, `${node.nodeId} must not acquire another node's output`);
  }
  assert.deepEqual(f.store.get('episodes', f.episode.id), f.episode, 'source collection must not rewrite the saved episode');
  assert.deepEqual(f.traffic, [], 'source collection must not estimate, generate, render, or publish');
  for (const kind of ['generationPlans', 'generationJobs', 'publicationStages', 'publicationIntents']) {
    assert.deepEqual(f.store.list(kind), [], `${kind} must not be created by selected news execution`);
  }
}

for (const query of ['국민연금공단', '국민연금공단 "기금 운용" + 수익률(5%): A&B/원화?']) {
  test(`configured query is exact despite unrelated title, topic, keywords and connected trend: ${query}`, async (t) => {
    const f = await fixture(t, { config: { query, keywords: KEYWORDS, source: 'google_news', maxArticles: 8 }, expectedQuery: query });
    const run = await f.execute();
    assert.equal(f.requests.length, 1, 'the unselected sibling must not issue another RSS request');
    assert.equal(f.requests[0].searchParams.get('q'), query, 'explicit query must never expand to unrelated context');
    assert.equal(f.requests[0].search, `?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`, 'Korean text and punctuation must survive one URL encoding');
    assert.equal(run.status, 'completed');
    const news = run.nodeRuns.find((node) => node.nodeId === 'news-original');
    assert.equal(news.status, 'completed');
    assert.equal(news.output.query, query);
    assert.equal(news.output.source, 'google_news');
    assert.equal(news.output.sourceUrl, f.requests[0].href);
    assert.deepEqual(news.output.articles.map(({ headline, source, url, summary, capturedAt, evidence }) => ({ headline, source, url, summary, capturedAt, evidence })), [{
      headline: HEADLINE, source: '검증일보', url: ARTICLE_URL, summary: SUMMARY,
      capturedAt: '2026-10-25T01:23:45.000Z',
      evidence: { source: '검증일보', url: ARTICLE_URL, publishedAt: PUBLISHED_AT },
    }]);
    assert.equal(news.output.scenarioOutline, `[씬 1] ${HEADLINE}: ${SUMMARY}`);
    assertSourceOnly(f, run, ['trend-original', 'news-original']);
  });
}

for (const queryConfig of [{}, { query: '' }]) {
  test(`context fallback is derived only when configured query is ${'query' in queryConfig ? 'empty' : 'omitted'}`, async (t) => {
    const expectedQuery = ['기금 운용', '수익률', TREND, TOPIC, TITLE].join(' OR ');
    const f = await fixture(t, { config: { ...queryConfig, keywords: KEYWORDS, source: 'google_news' }, expectedQuery });
    const run = await f.execute();
    assert.equal(run.status, 'completed');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].searchParams.get('q'), expectedQuery, 'fallback must include connected context and deduplicate comma keywords');
    const output = run.nodeRuns.find((node) => node.nodeId === 'news-original').output;
    assert.equal(output.query, expectedQuery);
    assert.deepEqual(output.keywords, ['기금 운용', '수익률', TREND, TOPIC, TITLE]);
    assertSourceOnly(f, run, ['trend-original', 'news-original']);
  });
}

test('only RSS items with a verified headline, safe article URL and source become news output', async (t) => {
  const f = await fixture(t, { config: { query: '국민연금공단', source: 'google_news', maxArticles: 8 }, expectedQuery: '국민연금공단', xml: rss(UNVERIFIED_ITEMS + VERIFIED_ITEM) });
  const run = await f.execute();
  assert.equal(run.status, 'completed');
  const output = run.nodeRuns.find((node) => node.nodeId === 'news-original').output;
  assert.deepEqual(output.articles.map(({ headline, source, url }) => ({ headline, source, url })), [{ headline: HEADLINE, source: '검증일보', url: ARTICLE_URL }]);
  assertSourceOnly(f, run, ['trend-original', 'news-original']);
});

for (const failure of [
  { name: 'HTTP 200 with zero items', xml: EMPTY_RSS, status: 200 },
  { name: 'HTTP 200 with only unverified items', xml: rss(UNVERIFIED_ITEMS), status: 200 },
  { name: 'HTTP 503 even with a valid article body', xml: rss(VERIFIED_ITEM), status: 503 },
]) {
  test(`${failure.name} fails news and its selected descendant without sample or cached-article success`, async (t) => {
    const f = await fixture(t, { config: { query: '국민연금공단', source: 'all', maxArticles: 8 }, expectedQuery: '국민연금공단', ...failure });
    f.store.create('trends', { keyword: '이전 검색의 캐시 기사', source: 'Cached Fixture RSS', url: 'https://publisher.example/stale-article' });
    const selectedStages = ['trend-original', 'news-original', 'research-original'];
    const run = await f.execute(selectedStages);
    assert.equal(f.requests.length, 1, 'a failed Google request must not trigger a hidden query retry');
    assert.equal(f.requests[0].searchParams.get('q'), '국민연금공단');
    assert.equal(run.status, 'failed');
    const news = run.nodeRuns.find((node) => node.nodeId === 'news-original');
    assert.equal(news.status, 'failed');
    assert.match(news.error, /failed|News source/i);
    assert.equal(news.output, undefined, 'no fabricated or stale articles may be persisted as successful news');
    const research = run.nodeRuns.find((node) => node.nodeId === 'research-original');
    assert.equal(research.status, 'skipped');
    assert.match(research.error, /upstream.*failed/i);
    assert.equal(research.output, undefined);
    assertSourceOnly(f, run, selectedStages);
  });
}
