import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBlogSources } from '../server/blog-sources.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'frameforge-blog-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shared = join(root, 'naver-blog-shared');
  const blog = join(root, 'naver-blog-banggujin');
  await mkdir(shared, { recursive: true });
  await mkdir(join(blog, 'persona'), { recursive: true });
  await writeFile(join(shared, 'aside-publish-guide.md'), '# Synthetic publisher rules\nNever publish test content.');
  await writeFile(join(shared, 'category-rotation-policy.json'), JSON.stringify({ blogs: { banggujin: { ring: [{ category_no: 41, name: '첫 테스트 메뉴' }, { category_no: 42, name: '다음 테스트 메뉴' }] } } }));
  await writeFile(join(shared, 'category-rotation-state.json'), JSON.stringify({ blogs: { banggujin: { next: { category_no: 42, category: '다음 테스트 메뉴' } } } }));
  await writeFile(join(shared, 'publish-slot-ledger.json'), '{}');
  await writeFile(join(blog, 'LATEST.md'), '# Synthetic latest state\nSource bytes A');
  await writeFile(join(blog, 'persona', 'parkjen-persona.md'), '# 격리 페르소나\nPrivate fixture rule text, never public state.');
  await writeFile(join(blog, 'blog-config.json'), JSON.stringify({ keywords: ['직접 조사 키워드'] }));
  return { root, shared, blog, load: () => loadBlogSources({ root, env: {}, bridgeMode: false, fetchImpl: async () => { throw Error('Source tests prohibit network access'); }, now: () => new Date('2026-10-25T00:00:00Z') }) };
}

test('canonical byte changes invalidate the source version even when timestamps and length do not change', async t => {
  const f = await fixture(t);
  const file = join(f.blog, 'LATEST.md');
  const stamp = new Date('2026-10-01T00:00:00Z');
  await utimes(file, stamp, stamp);
  const before = await f.load();
  await writeFile(file, '# Synthetic latest state\nSource bytes B');
  await utimes(file, stamp, stamp);
  const after = await f.load();
  assert.notEqual(after.workspace.version, before.workspace.version);
  const evidence = value => value.workspace.sourceEvidence.find(item => item.id === 'naver-banggujin/LATEST.md');
  assert.equal(evidence(before).modifiedAt, evidence(after).modifiedAt);
  assert.equal(evidence(before).bytes, evidence(after).bytes);
  assert.notEqual(evidence(before).sha256, evidence(after).sha256);
  assert.equal((await f.load()).workspace.version, after.workspace.version, 'Unchanged canonical bytes must keep the same approval identity');
});

test('current ring and next category resolve the real menu without exposing private source bodies', async t => {
  const f = await fixture(t);
  const result = await f.load();
  const account = result.accounts.find(item => item.id === 'naver-banggujin');
  assert.deepEqual(account.menus, ['첫 테스트 메뉴', '다음 테스트 메뉴']);
  assert.equal(account.menus[account.menuCursor], '다음 테스트 메뉴');
  assert.deepEqual(account.keywords, ['직접 조사 키워드']);
  assert.equal(account.persona, '격리 페르소나');
  assert.equal(JSON.stringify(result).includes('Private fixture rule text'), false);
  assert.equal(JSON.stringify(result).includes('Never publish test content'), false);
  await writeFile(join(f.shared, 'category-rotation-state.json'), JSON.stringify({ blogs: { banggujin: { next: { category_no: 99, category: '존재하지 않는 메뉴' } } } }));
  const invalid = await f.load();
  assert.match(invalid.workspace.blockedReasons.find(reason => reason.startsWith('naver-banggujin:') && reason.includes('category')), /missing|match/);
});

test('deleted and invalid UTF-8 latest sources become explicit blockers rather than stale retained evidence', async t => {
  const f = await fixture(t);
  const before = await f.load();
  const file = join(f.blog, 'LATEST.md');
  for (const mode of ['deleted', 'invalid']) {
    if (mode === 'deleted') await rm(file);
    else await writeFile(file, Buffer.from([0xff, 0xfe, 0xff]));
    const result = await f.load();
    assert.notEqual(result.workspace.version, before.workspace.version);
    const evidence = result.workspace.sourceEvidence.find(item => item.id === 'naver-banggujin/LATEST.md');
    assert.equal(evidence.status, mode === 'deleted' ? 'missing' : 'invalid');
    if (mode === 'deleted') assert.equal(evidence.sha256, null);
    else assert.match(evidence.sha256, /^[a-f0-9]{64}$/, 'Unreadable bytes still need a distinct identity to invalidate stale approvals');
    assert.ok(result.workspace.blockedReasons.some(reason => reason.startsWith('naver-banggujin:') && reason.includes('LATEST.md')));
  }
});

test('current pointers resolve numeric next category rather than historical entries and detect later canonical drift', async t => {
  const f = await fixture(t);
  const policy = { blogs: { banggujin: { ring: [{ category_no: 27, name: '육아지식' }, { category_no: 90, name: '과거 메뉴' }] } } };
  const rotation = { updated_at: '2026-10-22T09:00:00+09:00', blogs: { banggujin: { next: { category_no: 27, category: '육아지식' } } } };
  await writeFile(join(f.shared, 'category-rotation-policy.json'), JSON.stringify(policy));
  const statePath = join(f.shared, 'category-rotation-state.json');
  await writeFile(statePath, JSON.stringify(rotation));
  await writeFile(join(f.blog, 'LATEST.md'), '# Current source pointers\nPointer refresh: `2026-10-25T10:00:00+09:00`\nRotation source updated_at: `2026-10-22T09:00:00+09:00`\nCurrent next category: `27` / `육아지식`\n# Historical snapshot\nNext category: `90` / `과거 메뉴`\n2020-01-01\n');
  const before = await f.load();
  const selected = before.accounts.find(item => item.id === 'naver-banggujin');
  assert.deepEqual(selected.nextMenu, { categoryNo: 27, name: '육아지식' });
  assert.equal(selected.latestRecord.date, '2026-10-22');
  assert.equal(selected.latestRecord.pointerRefreshedAt, '2026-10-25T10:00:00+09:00');
  assert.equal(before.workspace.sourceConflicts.some(item => item.startsWith('naver-banggujin:')), false);
  rotation.updated_at = '2026-10-23T09:00:00+09:00';
  await writeFile(statePath, JSON.stringify(rotation));
  const after = await f.load();
  assert.notEqual(after.workspace.version, before.workspace.version);
  assert.ok(after.workspace.sourceConflicts.some(item => item.startsWith('naver-banggujin:')));
  assert.deepEqual(after.accounts.find(item => item.id === selected.id).nextMenu, selected.nextMenu);
});

test('a missing sibling persona is reported against that account without erasing the loaded account menu', async t => {
  const f = await fixture(t);
  const result = await f.load();
  const loaded = result.accounts.find(item => item.id === 'naver-banggujin');
  const missing = result.accounts.find(item => item.id === 'naver-jelly_ggumi');
  assert.deepEqual(loaded.nextMenu, { categoryNo: 42, name: '다음 테스트 메뉴' });
  assert.ok(missing.metadataRequirements.some(item => item.field === 'persona'));
  assert.ok(result.workspace.blockedReasons.some(item => item.startsWith(`${missing.id}:`) && item.includes('persona')));
  assert.equal(result.workspace.blockedReasons.some(item => item.startsWith(`${loaded.id}:`)), false);
});

for (const row of [
  { name: 'missing numeric identity', ring: [{ name: '잘못된 메뉴' }] },
  { name: 'duplicate numeric identity', ring: [{ category_no: 41, name: '첫 메뉴' }, { category_no: 41, name: '다른 메뉴' }] },
  { name: 'duplicate display labels', ring: [{ category_no: 41, name: '같은 메뉴' }, { category_no: 42, name: '같은 메뉴' }] },
]) test(`malformed ${row.name} blocks only its account and never retains a partially filtered ring`, async t => {
  const f = await fixture(t);
  await writeFile(join(f.shared, 'category-rotation-policy.json'), JSON.stringify({ blogs: { banggujin: { ring: row.ring }, jelly_ggumi: { ring: [{ category_no: 73, name: '건강한 메뉴' }] } } }));
  await writeFile(join(f.shared, 'category-rotation-state.json'), JSON.stringify({ blogs: { banggujin: { next: { category_no: 41, category: '첫 메뉴' } }, jelly_ggumi: { next: { category_no: 73, category: '건강한 메뉴' } } } }));
  const result = await f.load();
  const broken = result.accounts.find(item => item.id === 'naver-banggujin');
  const healthy = result.accounts.find(item => item.id === 'naver-jelly_ggumi');
  assert.deepEqual(broken.menuEntries, []);
  assert.equal(broken.nextMenu, null);
  assert.ok(result.workspace.blockedReasons.some(item => item.startsWith(`${broken.id}:`) && /malformed|duplicate|numeric/i.test(item)));
  assert.deepEqual(healthy.nextMenu, { categoryNo: 73, name: '건강한 메뉴' });
});
