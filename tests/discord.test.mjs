import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import {
  validateDiscordWebhookUrl,
  validateChannelId,
  normalizeAllowedUserIds,
  extractDiscordCommand,
  buildDiscordIntegrationStatus,
} from '../server/discord.mjs';
import { runFrameForgeCli } from '../scripts/frameforge-cli.mjs';

async function setup(t, { discordEnv = {}, discordFetch, renderer, loginToken = '' } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-discord-'));
  const integrations = {
    integrationStatus: async ({ discord } = {}) => ({
      studio: { available: true, status: 'available' },
      discord: discord || buildDiscordIntegrationStatus({}, discordEnv),
    }),
    runAgent: async () => { throw Object.assign(new Error('no bridge'), { code: 'UNAVAILABLE' }); },
    fetchTrends: async () => ({ trends: [{ keyword: '검증 키워드', source: 'Test', url: 'https://example.com' }], sources: [{ name: 'Test', status: 'ok' }] }),
  };
  const makeOptions = () => ({
    dataDir,
    loginToken,
    publicOrigin: '',
    integrations,
    renderer,
    discordOptions: {
      env: discordEnv,
      fetchImpl: discordFetch || (async () => { throw new Error('Unexpected Discord fetch'); }),
      apiBase: 'https://discord.test/api/v10',
    },
  });
  let server = createApp(makeOptions());
  const start = async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  let base = await start();
  const close = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  t.after(async () => {
    await close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    request: (path, method = 'GET', body, headers = {}) => fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    restart: async () => {
      await close();
      server = createApp(makeOptions());
      base = await start();
    },
  };
}

test('Discord validators reject unsafe webhooks, invalid snowflakes and malformed prefixes', () => {
  assert.equal(validateDiscordWebhookUrl(''), '');
  assert.equal(
    validateDiscordWebhookUrl('https://discord.com/api/webhooks/1483450881146880145/abcDEF_123-xyz'),
    'https://discord.com/api/webhooks/1483450881146880145/abcDEF_123-xyz',
  );
  for (const bad of [
    'http://discord.com/api/webhooks/1483450881146880145/token',
    'https://evil.example/api/webhooks/1483450881146880145/token',
    'https://discord.com/api/webhooks/1483450881146880145/token?wait=true',
    'https://user:pass@discord.com/api/webhooks/1483450881146880145/token',
    'https://discord.com/api/v10/channels/1483450881146880145/messages',
  ]) assert.throws(() => validateDiscordWebhookUrl(bad), /Discord/i);

  assert.equal(validateChannelId('1483450881146880145', true), '1483450881146880145');
  assert.throws(() => validateChannelId('not-a-snowflake', true), /channelId/);
  assert.deepEqual(normalizeAllowedUserIds('633281085282844672, 633281085282844672'), ['633281085282844672']);
  assert.throws(() => normalizeAllowedUserIds('bad-user'), /allowedUserIds/);

  assert.equal(extractDiscordCommand('!ff 상태 확인', '!ff'), '상태 확인');
  assert.equal(extractDiscordCommand('!FF: render check', '!ff'), 'render check');
  assert.equal(extractDiscordCommand('!ffx ignore', '!ff'), null);
  assert.equal(extractDiscordCommand('hello world', '!ff'), null);
});

test('Discord status stays pure without network calls and never leaks credentials', async (t) => {
  const secretToken = 'super-secret-bot-token-value-123456';
  const f = await setup(t, {
    discordEnv: { DISCORD_BOT_TOKEN: secretToken, DISCORD_CHANNEL_ID: '1483450881146880145' },
  });
  const res = await f.request('/api/integrations/discord');
  assert.equal(res.status, 200);
  const status = await res.json();
  assert.equal(status.available, false);
  assert.equal(status.configured, true);
  assert.equal(status.status, 'configured');
  assert.equal(status.hasBotToken, true);
  assert.equal(status.channelId, '1483450881146880145');

  const stateText = await (await f.request('/api/state')).text();
  assert.equal(stateText.includes(secretToken), false);
});

test('Discord settings, live REST verify, test notification, and restart persistence work without leaking secrets', async (t) => {
  const secretToken = 'bot-token-secret-xyz-999999';
  const calls = [];
  const f = await setup(t, {
    discordEnv: { DISCORD_BOT_TOKEN: secretToken },
    discordFetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET', headers: options.headers, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/users/@me')) return new Response(JSON.stringify({ id: '1484763709762048121', username: '제오파이_윈도우' }), { status: 200 });
      if (url.endsWith('/channels/1483450881146880145') && (options.method || 'GET') === 'GET') {
        return new Response(JSON.stringify({ id: '1483450881146880145', name: '업무룸' }), { status: 200 });
      }
      if (url.endsWith('/channels/1483450881146880145/messages') && options.method === 'POST') {
        return new Response(JSON.stringify({ id: '1571500000000000001' }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'Not found' }), { status: 404 });
    },
  });

  const saved = await f.request('/api/integrations/discord', 'PUT', {
    enabled: true,
    channelId: '1483450881146880145',
    commandPrefix: '!ff',
    allowedUserIds: ['633281085282844672'],
    notifyEvents: { workflow: true, review: true, render: true, publication: false },
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.channelId, '1483450881146880145');
  assert.equal(savedBody.notifyEvents.publication, false);

  const verified = await f.request('/api/integrations/discord/verify', 'POST', {});
  assert.equal(verified.status, 200);
  const verifiedBody = await verified.json();
  assert.equal(verifiedBody.available, true);
  assert.equal(verifiedBody.status, 'available');
  assert.equal(verifiedBody.botUser.username, '제오파이_윈도우');
  assert.equal(verifiedBody.channelName, '업무룸');

  const tested = await f.request('/api/integrations/discord/test', 'POST', { message: '연결 실동작 확인' });
  assert.equal(tested.status, 200);
  const testedBody = await tested.json();
  assert.equal(testedBody.ok, true);
  assert.equal(testedBody.messageId, '1571500000000000001');
  const postCall = calls.find((c) => c.method === 'POST');
  assert.equal(postCall.headers.authorization, `Bot ${secretToken}`);
  assert.deepEqual(postCall.body.allowed_mentions, { parse: [] });
  assert.match(postCall.body.content, /연결 실동작 확인/);

  await f.restart();
  const afterRestart = await (await f.request('/api/integrations/discord')).json();
  assert.equal(afterRestart.available, true);
  assert.equal(afterRestart.channelId, '1483450881146880145');
  assert.equal(afterRestart.channelName, '업무룸');
  assert.equal(JSON.stringify(afterRestart).includes(secretToken), false);
});

test('Discord command sync filters bots/users/prefix and deduplicates across restarts', async (t) => {
  const f = await setup(t, {
    discordEnv: {
      DISCORD_BOT_TOKEN: 'bot-token-sync-test',
      DISCORD_CHANNEL_ID: '1483450881146880145',
      DISCORD_ALLOWED_USER_IDS: '633281085282844672',
    },
    discordFetch: async (url) => {
      if (url.includes('after=1571500000000000004')) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify([
        { id: '1571500000000000004', content: '!ff 에피소드 상태 점검', timestamp: '2026-11-15T08:00:00.000Z', author: { id: '633281085282844672', username: 'dev_jeo', bot: false } },
        { id: '1571500000000000003', content: '!ff ignored-bot', timestamp: '2026-11-15T07:59:00.000Z', author: { id: '1488354420407406775', username: 'hermes', bot: true } },
        { id: '1571500000000000002', content: '!ff unauthorized-user', timestamp: '2026-11-15T07:58:00.000Z', author: { id: '999999999999999999', username: 'stranger', bot: false } },
        { id: '1571500000000000001', content: '일반 대화 메시지', timestamp: '2026-11-15T07:57:00.000Z', author: { id: '633281085282844672', username: 'dev_jeo', bot: false } },
      ]), { status: 200 });
    },
  });

  const first = await (await f.request('/api/integrations/discord/sync', 'POST', { limit: 10 })).json();
  assert.equal(first.fetched, 4);
  assert.equal(first.imported, 1);
  assert.equal(first.skipped, 3);
  assert.equal(first.lastSyncedMessageId, '1571500000000000004');
  assert.equal(first.commands[0].source, 'discord');
  assert.equal(first.commands[0].message, '에피소드 상태 점검');
  assert.equal(first.commands[0].authorName, 'dev_jeo');

  await f.restart();
  const second = await (await f.request('/api/integrations/discord/sync', 'POST', { limit: 10 })).json();
  assert.equal(second.imported, 0);
  const commands = await (await f.request('/api/commands')).json();
  assert.equal(commands.length, 1);
});

test('Render and workflow notifications run non-blocking and never break execution when Discord fails', async (t) => {
  const delivered = [];
  let failDiscord = false;
  const f = await setup(t, {
    discordEnv: {
      DISCORD_BOT_TOKEN: 'bot-token-hooks',
      DISCORD_CHANNEL_ID: '1483450881146880145',
      DISCORD_NOTIFY_ENABLED: 'true',
    },
    renderer: async (_episode, { dataDir }) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dataDir, 'exports', 'discord-hook.mp4'), 'mp4-bytes');
      return { outputUrl: '/api/exports/discord-hook.mp4', filename: 'discord-hook.mp4', sha256: 'a'.repeat(64) };
    },
    discordFetch: async (_url, options = {}) => {
      if (failDiscord) return new Response(JSON.stringify({ message: 'Upstream outage' }), { status: 500 });
      delivered.push(JSON.parse(options.body).content);
      return new Response(JSON.stringify({ id: String(1571600000000000000 + delivered.length) }), { status: 200 });
    },
  });

  const state = await (await f.request('/api/state')).json();
  const episode = await (await f.request('/api/episodes', 'POST', { channelId: state.channels[0].id, title: '알림 테스트 에피소드', topic: '테스트' })).json();

  const renderRes = await f.request(`/api/episodes/${episode.id}/render`, 'POST', { expectedVersion: episode.version });
  assert.equal(renderRes.status, 202);
  const job = await renderRes.json();

  for (let i = 0; i < 40; i++) {
    const cur = await (await f.request('/api/state')).json();
    const found = cur.jobs.find((j) => j.id === job.id);
    if (found?.status === 'completed' && delivered.length >= 1) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(delivered.some((msg) => msg.includes('[FrameForge 렌더] 완료') && msg.includes('알림 테스트 에피소드')));

  failDiscord = true;
  const renderRes2 = await f.request(`/api/episodes/${episode.id}/render`, 'POST', { expectedVersion: episode.version });
  assert.equal(renderRes2.status, 202);
  const job2 = await renderRes2.json();
  let finalJob2;
  for (let i = 0; i < 40; i++) {
    const cur = await (await f.request('/api/state')).json();
    finalJob2 = cur.jobs.find((j) => j.id === job2.id);
    if (finalJob2?.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(finalJob2.status, 'completed');
});

test('Discord routes enforce admin auth and same-origin protections', async (t) => {
  const f = await setup(t, {
    loginToken: 'secret-admin-token-123456',
    discordEnv: { DISCORD_BOT_TOKEN: 'bot-token-auth', DISCORD_CHANNEL_ID: '1483450881146880145' },
  });
  assert.equal((await f.request('/api/integrations/discord')).status, 401);
  assert.equal((await f.request('/api/integrations/discord/verify', 'POST', {})).status, 401);
  const login = await f.request('/api/login', 'POST', { token: 'secret-admin-token-123456' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('/api/integrations/discord', 'GET', undefined, { Cookie: cookie })).status, 200);
  assert.equal((await f.request('/api/integrations/discord/test', 'POST', {}, { Cookie: cookie, Origin: 'https://evil.example' })).status, 403);
});

test('frameforge-cli lists operations, executes calls, and rejects unsafe URLs', async (t) => {
  const f = await setup(t, { loginToken: 'cli-test-token-123456' });
  const port = Number(new URL(await (async () => {
    const res = await f.request('/api/health');
    return res.url;
  })()).port);
  const env = { FRAMEFORGE_URL: `http://127.0.0.1:${port}`, FRAMEFORGE_TOKEN: 'cli-test-token-123456' };
  const capture = () => {
    let out = '', err = '';
    return {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: (s) => { err += s; } },
      read: () => ({ out, err }),
    };
  };

  const c1 = capture();
  assert.equal(await runFrameForgeCli(['list'], { env, stdout: c1.stdout, stderr: c1.stderr }), 0);
  const ops = JSON.parse(c1.read().out).operations;
  assert.ok(ops.some((op) => op.name === 'episode_list'));
  assert.ok(ops.some((op) => op.name === 'workflow_node_types'));

  const c2 = capture();
  assert.equal(await runFrameForgeCli(['call', 'workflow_node_types', '{}'], { env, stdout: c2.stdout, stderr: c2.stderr }), 0);
  const typesRes = JSON.parse(c2.read().out);
  assert.equal(typesRes.ok, true);
  assert.equal(typesRes.result.types.length, 10);

  const c3 = capture();
  assert.equal(await runFrameForgeCli(['call', 'episode_get', '{"episodeId":"missing"}'], { env, stdout: c3.stdout, stderr: c3.stderr }), 1);
  assert.equal(JSON.parse(c3.read().err).status, 404);

  const c4 = capture();
  await assert.rejects(() => runFrameForgeCli(['list'], { env: { FRAMEFORGE_URL: 'http://evil.example:4310' }, stdout: c4.stdout, stderr: c4.stderr }), /HTTPS origin or loopback/);
});
