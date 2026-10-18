import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-store-knowledge-'));
  const store = new Store(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store };
}

test('knowledge deduplicates a repeated topic without dropping episode nodes, edges, or atoms', async (t) => {
  const { store } = await fixture(t);
  const channel = store.list('channels')[0];
  const sharedTopic = 'Repeated graph topic';
  const episodes = [
    { id: 'episode-a', title: 'First episode', topic: sharedTopic },
    { id: 'episode-b', title: 'Second episode', topic: sharedTopic },
  ];
  for (const episode of episodes) store.save('episodes', {
    ...episode,
    channelId: channel.id,
    status: 'draft',
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const graph = store.knowledge();
  const topicId = `topic-${createHash('sha256').update(sharedTopic).digest('hex').slice(0, 20)}`;
  const topicNodes = graph.nodes.filter((node) => node.id === topicId);
  const topicAtoms = graph.atoms.filter((atom) => atom.id === topicId);
  assert.equal(topicNodes.length, 1);
  assert.equal(topicAtoms.length, 1);
  assert.deepEqual(graph.nodes.filter((node) => node.type === 'episode').map((node) => node.id), ['episode-b', 'episode-a']);
  assert.deepEqual(graph.atoms.filter((atom) => atom.type === 'episode').map((atom) => [atom.id, atom.related]), [
    ['episode-b', [channel.id, topicId]],
    ['episode-a', [channel.id, topicId]],
  ]);
  assert.deepEqual(graph.edges.filter((edge) => edge.source.startsWith('episode-')).map((edge) => [edge.source, edge.target, edge.relation]), [
    ['episode-b', channel.id, 'belongs_to'],
    ['episode-b', topicId, 'belongs_to'],
    ['episode-a', channel.id, 'belongs_to'],
    ['episode-a', topicId, 'belongs_to'],
  ]);
});

test('knowledge preserves distinct reference nodes and repeated edges to one channel', async (t) => {
  const { store } = await fixture(t);
  const channel = store.list('channels')[0];
  for (const [id, title] of [['reference-a', 'First source'], ['reference-b', 'Second source']]) store.save('references', {
    id,
    title,
    notes: 'Same channel, separate source',
    category: 'research',
    channelId: channel.id,
    url: `https://example.test/${id}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const graph = store.knowledge();
  assert.deepEqual(graph.nodes.filter((node) => node.type === 'reference').map((node) => node.id), ['reference-b', 'reference-a']);
  assert.deepEqual(graph.atoms.filter((atom) => atom.type === 'reference').map((atom) => [atom.id, atom.related, atom.resource]), [
    ['reference-b', [channel.id], 'https://example.test/reference-b'],
    ['reference-a', [channel.id], 'https://example.test/reference-a'],
  ]);
  assert.deepEqual(graph.edges.filter((edge) => edge.target === channel.id && edge.relation === 'references').map((edge) => edge.source), ['reference-b', 'reference-a']);
});

test('iterate yields the same records in the same order as list', async (t) => {
  const { store } = await fixture(t);
  for (const [id, title] of [['reference-a', 'First source'], ['reference-b', 'Second source']]) store.save('references', {
    id,
    title,
    category: 'research',
    url: `https://example.test/${id}`,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.deepEqual([...store.iterate('references')], store.list('references'));
});
