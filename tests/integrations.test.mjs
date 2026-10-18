import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrendRss, fetchTrends, integrationStatus, runAgent } from '../server/integrations.mjs';
import { execute } from '../server/process.mjs';

function replaceFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = original; });
}

function setEnvironment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test('RSS parsing decodes Korean CDATA/entities and bounds/filter invalid items', () => {
  const rows = parseTrendRss('<rss><channel><item><title><![CDATA[한국 드라마 &amp; 정보]]></title></item><item><title></title></item><item><title>&lt;재연&gt; &quot;사실&quot; &#39;확인&#39;</title></item></channel></rss>');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].keyword, '한국 드라마 & 정보');
  assert.equal(rows[1].keyword, '<재연> "사실" \'확인\'');
  assert.equal(rows[0].source, 'Google Trends KR');
  assert.equal(rows[0].url, 'https://trends.google.com/trending?geo=KR');
  assert.ok(Number.isFinite(Date.parse(rows[0].capturedAt)));
  assert.equal(parseTrendRss('<item><title>' + 'x'.repeat(200) + '</title></item>').length, 0);
  assert.equal(parseTrendRss('<item><title>keyword</title></item>'.repeat(100)).length, 40);
  assert.deepEqual(parseTrendRss('<html>not a feed</html>'), []);
});

test('trend refresh returns captured RSS results and labels Naver manual', async (t) => {
  replaceFetch(t, async (url, options) => {
    assert.equal(url, 'https://trends.google.com/trending/rss?geo=KR');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response('<rss><item><title>검증된 테스트 키워드</title></item></rss>');
  });
  const result = await fetchTrends();
  assert.equal(result.trends[0].keyword, '검증된 테스트 키워드');
  assert.equal(result.sources[0].status, 'ok');
  assert.equal(result.sources[1].name, 'Naver DataLab');
  assert.equal(result.sources[1].status, 'manual');
});

test('trend failures remain explicit and never fabricate current rankings', async (t) => {
  for (const response of [new Response('unavailable', { status: 503 }), new Response('<rss/>'), new Response('x'.repeat(2_000_001))]) {
    await t.test(`failure ${response.status} / ${response.headers.get('content-type')}`, async (subtest) => {
      replaceFetch(subtest, async () => response);
      const result = await fetchTrends();
      assert.deepEqual(result.trends, []);
      assert.equal(result.sources[0].status, 'error');
      assert.equal(result.sources[1].status, 'manual');
    });
  }
});

test('unconfigured bridge status is unavailable and rejects remote calls before fetch', async (t) => {
  setEnvironment(t, { AGENT_BRIDGE_TOKEN: undefined });
  replaceFetch(t, async () => { throw new Error('Unexpected network request'); });
  const status = await integrationStatus();
  assert.equal(status.studio.available, true);
  for (const agent of ['codex', 'jeo', 'jeopi', 'hermes']) assert.equal(status[agent].available, false);
  await assert.rejects(runAgent('codex', 'test', {}), /not configured/);
  await assert.rejects(runAgent('unrecognized', 'test', {}), /Unknown agent/);
});

test('agent bridge preserves scoped request, bearer auth and explicit failure', async (t) => {
  setEnvironment(t, { AGENT_BRIDGE_TOKEN: 'test-internal-token', AGENT_BRIDGE_URL: 'http://127.0.0.1:4311' });
  let calls = 0;
  replaceFetch(t, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:4311/run');
    assert.equal(options.headers.authorization, 'Bearer test-internal-token');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { agent: 'jeopi', message: '한국어 요청', episode: { id: 'episode-1' } });
    calls += 1;
    return calls === 1 ? new Response(JSON.stringify({ message: '검증 결과' })) : new Response(JSON.stringify({ error: 'Provider unavailable' }), { status: 503 });
  });
  assert.deepEqual(await runAgent('jeopi', '한국어 요청', { id: 'episode-1' }), { message: '검증 결과' });
  await assert.rejects(runAgent('jeopi', '한국어 요청', { id: 'episode-1' }), /Provider unavailable/);
});

test('process runner passes arguments without shell expansion and bounds output/failure', async () => {
  const literal = '$(not-a-command) & | ; " 한국어';
  const result = await execute(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(result.stdout, literal);
  await assert.rejects(execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { maxBytes: 128 }), /exceeded limit/);
  await assert.rejects(execute(process.execPath, ['-e', 'process.stderr.write("intentional failure");process.exit(7)']), /exited 7/);
  const started = Date.now();
  await assert.rejects(execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), /timed out/);
  assert.ok(Date.now() - started < 5000);
});

test('bridge malformed status remains unavailable instead of crashing', async (t) => {
  setEnvironment(t, { AGENT_BRIDGE_TOKEN: 'test-internal-token' });
  replaceFetch(t, async () => new Response('{}'));
  const status = await integrationStatus();
  assert.equal(status.codex.available, false);
});

test('process output preserves Korean UTF-8 split across chunks', async () => {
  const script = 'const b=Buffer.from("한글");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),50)';
  const result = await execute(process.execPath, ['-e', script]);
  assert.equal(result.stdout, '한글');
});
