import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { renderEpisode } from '../server/render.mjs';

const run = promisify(execFile);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('equal-length attribution changes alter decoded credit glyph pixels in a real FFmpeg render', { timeout: 180000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-credit-pixels-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, 'uploads'));
  const filename = '11111111-1111-4111-8111-111111111111.png';
  await writeFile(join(dataDir, 'uploads', filename), PNG);
  const scene = {
    id: 'credited-scene', kind: 'image', assetUrl: `/api/uploads/${filename}`,
    title: 'Credit pixels', text: '', narration: '', duration: 1,
    background: '#000000', layout: 'center', trimStart: 0, audioVolume: 1,
    source: { origin: 'third-party', attribution: 'ALICE AMBER', licenseId: 'CC-BY-4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Credit.png' },
  };
  assert.equal('ALICE AMBER'.length, 'BRUNO BROWN'.length);
  const frames = [];
  for (const attribution of ['ALICE AMBER', 'BRUNO BROWN']) {
    const result = await renderEpisode({ format: '9:16', scenes: [{ ...scene, source: { ...scene.source, attribution } }] }, { dataDir });
    const { stdout } = await run(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-v', 'error', '-i', join(dataDir, 'exports', result.filename), '-ss', '0.4',
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    assert.equal(stdout.length, 1080 * 1920 * 3, 'inspect actual decoded RGB pixels, not MP4 bytes or scene metadata');
    frames.push(stdout);
  }
  let different = 0, bright = 0;
  let minX = 1080, maxX = 0, minY = 1920, maxY = 0;
  for (let p = 0; p < 1080 * 1920; p++) {
    const i = p * 3;
    if (Math.max(...frames[0].subarray(i, i + 3)) > 150) bright++;
    if ([0, 1, 2].some(c => Math.abs(frames[0][i + c] - frames[1][i + c]) > 40)) {
      different++;
      const x = p % 1080, y = Math.floor(p / 1080);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  await writeFile(new URL('../artifacts/production-workspace-implementation/journey-credit-pixels.json', import.meta.url), JSON.stringify({
    command: 'node --test tests/production-media-credits.test.mjs',
    format: 'decoded rgb24 1080x1920 at 0.4s', sameLengthAttributions: ['ALICE AMBER', 'BRUNO BROWN'],
    decodedFrameSha256: frames.map(bytes => createHash('sha256').update(bytes).digest('hex')),
    changedGlyphPixels: different, brightPixels: bright, glyphDifferenceBounds: { minX, maxX, minY, maxY },
    verifiedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  assert.ok(bright > 250, `credits must contain visible high contrast glyphs on the otherwise black frame: ${bright}`);
  assert.ok(different > 100, `equal-length author names must change decoded glyphs: ${different} changed pixels`);
  assert.ok(maxX - minX > 70 && maxY - minY > 10, `changes must occupy readable text geometry: ${JSON.stringify({ minX, maxX, minY, maxY })}`);
});

test('requiredMediaCredits includes scene and slot rights once, deterministically, without invented credits', async () => {
  const { requiredMediaCredits } = await import('../server/media-credits.mjs');
  const first = { origin: 'third-party', attribution: 'First Author', licenseId: 'CC-BY-4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:First.png' };
  const second = { origin: 'third-party', attribution: 'Second Author', licenseId: 'CC-BY-SA-4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Second.webm' };
  const scenes = [{ source: first, slots: [{ source: second }, { source: first }] }, { kind: 'title', text: 'Original reporting card' }];
  const credits = requiredMediaCredits(scenes);
  assert.equal(typeof credits, 'string');
  assert.equal(credits.split('\n').length, 2, 'deduplicate repeated rights evidence rather than silently dropping a different source');
  for (const value of [...Object.values(first), ...Object.values(second)].filter(v => v !== 'third-party')) assert.ok(credits.includes(value), `missing server credit: ${value}`);
  assert.equal(requiredMediaCredits(structuredClone(scenes)), credits);
  assert.equal(requiredMediaCredits([{ kind: 'title', text: 'Original card' }, { source: { origin: 'own' } }]), '', 'no fabricated author or license for an original text card');
});
