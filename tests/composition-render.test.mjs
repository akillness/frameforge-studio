import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCompositionMediaFilter, buildCompositionAss, buildSceneCompositionPlan, buildSceneMediaFilter } from '../server/render.mjs';

import { fitText } from '../public/composition.js';

const scene={title:'제목',text:'한글 본문 {\\pos(0,0)}',background:'#123456',layout:'center',assetUrl:'/api/uploads/11111111-1111-1111-1111-111111111111.png',composition:{media:{x:.25,y:.1,width:.5,height:.6},title:{x:.1,y:.2,width:.8,height:.15},body:{x:.15,y:.5,width:.7,height:.2}}};

test('MP4 media filter uses the saved normalized media rectangle',()=>{
  const filter=buildCompositionMediaFilter(scene,1080,1920);
  assert.match(filter,/scale=540:1152:force_original_aspect_ratio=decrease/);
  assert.match(filter,/pad=540:1152:\(ow-iw\)\/2:\(oh-ih\)\/2:color=#123456/);
  assert.match(filter,/pad=1080:1920:270:192:color=#123456/);
});

test('MP4 media scaling and placement stay chroma-safe for odd normalized dimensions',()=>{
  const odd={...scene,composition:{...scene.composition,media:{x:.251,y:.103,width:.501,height:.501}}};
  const filter=buildCompositionMediaFilter(odd,1080,1920);
  assert.match(filter,/scale=542:962:force_original_aspect_ratio=decrease/);
  assert.match(filter,/pad=542:962:/);
  assert.match(filter,/pad=1080:1920:270:196:/);
});

test('ASS title and body events use saved geometry and escape control-tag injection',()=>{
  const script=buildCompositionAss(scene,1080,1920);
  assert.match(script,/PlayResX: 1080/);
  assert.match(script,/PlayResY: 1920/);
  assert.match(script,/pos\(540,528\)/);
  assert.match(script,/pos\(540,1152\)/);
  assert.match(script,/제목/);
  assert.match(script,/한글 본문/);
  assert.ok(!script.includes(`{${String.fromCharCode(92)}pos(0,0)`));
});

test('legacy scene presets produce deterministic render defaults',()=>{
  const legacy={title:'레거시',text:'본문',background:'#123456',layout:'split'};
  assert.match(buildCompositionMediaFilter({...legacy,assetUrl:scene.assetUrl},1080,1920),/pad=1080:1920:0:0:color=#123456/);
  const script=buildCompositionAss(legacy,1080,1920);
  assert.match(script,/pos\(540,1190\)/);
});


test('narrow title and body boxes fit Korean graphemes horizontally and vertically', () => {
  for (const layer of ['title', 'body']) {
    const box = { x: .2, y: .1, width: .02, height: .5 };
    const fitted = fitText('\uD55C', box, 1080, 1920, layer);
    assert.equal(fitted.text, '\uD55C');
    assert.ok(fitted.fontSize > 0 && fitted.fontSize <= 21.6, `${layer} font ${fitted.fontSize} exceeds 21.6px width`);
    assert.ok(fitted.lineHeight <= 960);
  }
});

test('U+FDFD receives a conservative wide-glyph budget in preview and ASS',()=>{
  const ligature=String.fromCodePoint(0xFDFD),box={x:.2,y:.1,width:.02,height:.5};
  for (const layer of ['title','body']) {
    const fitted=fitText(ligature,box,1080,1920,layer);
    assert.equal(fitted.text,ligature);
    assert.ok(fitted.fontSize>0&&fitted.fontSize*2<=21.6,`${layer}: U+FDFD at ${fitted.fontSize}px exceeds 21.6px`);
    const current={...scene,title:'',text:'',[layer==='title'?'title':'text']:ligature,composition:{...scene.composition,[layer]:box}};
    const assSize=Number(buildCompositionAss(current,1080,1920).match(new RegExp(String.fromCharCode(92).repeat(2)+'fs([0-9.]+)'))[1]);
    assert.ok(assSize>0&&assSize*2<=21.6,`${layer}: ASS size ${assSize}px exceeds the 21.6px glyph budget`);
  }
});

test('spacing Jamo clusters fit preview and ASS without splitting a grapheme', () => {
  const box = { x: .2, y: .1, width: .02, height: .5 };
  for (const count of [20, 2000]) {
    const cluster = '\u1100'.repeat(count);
    assert.equal(Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(cluster)).length, 1);
    for (const layer of ['title', 'body']) {
      const fitted = fitText(cluster, box, 1080, 1920, layer);
      assert.equal(fitted.text, cluster);
      // Each leading Jamo is a spacing glyph even though segmentation yields one cluster.
      assert.ok(fitted.fontSize > 0 && fitted.fontSize <= 21.6 / count,
        `${layer}: ${count} spacing Jamo at ${fitted.fontSize}px exceed 21.6px`);
      assert.ok(fitted.lineHeight <= 960);
      const current = { ...scene, title: '', text: '', [layer === 'title' ? 'title' : 'text']: cluster, composition: { ...scene.composition, [layer]: box } };
      const script = buildCompositionAss(current, 1080, 1920);
      const assSize = Number(script.match(/\\fs([\d.]+)/)[1]);
      assert.ok(assSize > 0 && assSize <= 21.6 / count);
      assert.ok(script.includes('}' + cluster + '\n'));
    }
  }
});


test('fitted preview and ASS preserve emoji and combining graphemes at line boundaries', () => {
  const value = '\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}e\u0301\uD55C';
  const box = { x: .2, y: .1, width: .02, height: .5 };
  for (const layer of ['title', 'body']) {
    const fitted = fitText(value, box, 1080, 1920, layer);
    assert.equal(fitted.text, '\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}\ne\u0301\n\uD55C');
    const current = { ...scene, title: '', text: '', [layer === 'title' ? 'title' : 'text']: value, composition: { ...scene.composition, [layer]: box } };
    const script = buildCompositionAss(current, 1080, 1920);
    assert.ok(script.includes('\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}' + String.fromCharCode(92) + 'N' + 'e\u0301' + String.fromCharCode(92) + 'N\uD55C'));
  }
});


test('minimum composition boxes keep positive text sizes within fractional canvas bounds', () => {
  const box = { x: .98, y: .98, width: .02, height: .02 };
  for (const layer of ['title', 'body']) {
    const fitted = fitText('A', box, 2, 2, layer);
    assert.equal(fitted.text, 'A');
    assert.ok(Number.isFinite(fitted.fontSize) && fitted.fontSize > 0 && fitted.fontSize <= .04);
    assert.ok(fitted.lineHeight <= .04);
    const script = buildCompositionAss({ ...scene, composition: { media: box, title: box, body: box } }, 2, 2);
    assert.ok(!/NaN|Infinity/.test(script));
    const filter = buildCompositionMediaFilter({ ...scene, composition: { media: box, title: box, body: box } }, 2, 2);
    assert.match(filter, /scale=2:2:/);
  }
});


test('slot-based plans retain each layer and legacy global captions alongside composition geometry', () => {
  const slots = [
    { id: 'video', role: 'video-bg', x: 0, y: 50, w: 100, h: 50, zIndex: 1, assetUrl: scene.assetUrl, mediaKind: 'image' },
    { id: 'banner', role: 'html-overlay', x: 4, y: 3, w: 92, h: 12, zIndex: 8, html: '<strong>Slot headline</strong>', style: { backgroundColor: '#123456' } },
  ];
  const plan = buildSceneCompositionPlan({ ...scene, slots }, 1080, 1920);
  const legacy = buildSceneCompositionPlan({ ...scene, slots, composition: undefined }, 1080, 1920);
  assert.equal(plan.hasSlots, true);
  assert.equal(plan.slotBoxes.length, 2);
  assert.deepEqual(plan.slotBoxes.map(box => [box.slot.id, box.sx, box.sy, box.sw, box.sh]), [['video', 0, 960, 1080, 960], ['banner', 43, 58, 992, 230]]);
  assert.deepEqual(plan.slotAss, legacy.slotAss);
  assert.equal(plan.globalAss, legacy.globalAss);
  assert.ok(plan.globalAss);
  assert.match(plan.slotAss[1], /Slot headline/);
  assert.match(plan.ass, /Style: Slot1/);
  assert.equal(buildSceneCompositionPlan(scene, 1080, 1920).ass, buildCompositionAss(scene, 1080, 1920));
});

test('long Unicode text stays within both box dimensions and preserves literal newline handling', () => {
  const value = ('\uD55C\u{1F1F0}\u{1F1F7}e\u0301\n').repeat(200);
  const box = { x: .1, y: .1, width: .02, height: .02 };
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  for (const layer of ['title', 'body']) {
    const fitted = fitText(value, box, 1080, 1920, layer);
    const lines = fitted.text.split('\n');
    assert.ok(lines.length * fitted.lineHeight <= 38.4);
    for (const line of lines) assert.ok(Array.from(segmenter.segment(line)).length * fitted.fontSize <= 21.6);
    assert.ok(fitted.fontSize > 0);
  }
});

test('fitText preserves every grapheme when the box forces fractional sizes', () => {
  const value = '한'.repeat(2000);
  const fitted = fitText(value, { x: .1, y: .1, width: .02, height: .02 }, 1080, 1920, 'body');
  assert.equal(fitted.text.replace(/\n/g, ''), value);
  assert.ok(fitted.fontSize > 0);
  assert.ok(fitted.text.split('\n').length * fitted.lineHeight <= .02 * 1920);
  for (const line of fitted.text.split('\n')) assert.ok(line.length * fitted.fontSize <= .02 * 1080);
});

test('fitText preserves every explicit paragraph when one-pixel text cannot fit', () => {
  const value = Array.from({ length: 50 }, (_, index) => String.fromCharCode(0xAC00 + index)).join('\n');
  const fitted = fitText(value, { x: .1, y: .1, width: .02, height: .02 }, 1080, 1920, 'body');
  assert.equal(fitted.text, value);
  assert.ok(fitted.text.split('\n').length * fitted.lineHeight <= .02 * 1920);
  assert.ok(fitted.fontSize > 0 && fitted.fontSize <= .02 * 1080);
});

test('ASS export preserves every explicit paragraph in a tiny body box', () => {
  const value = Array.from({ length: 50 }, (_, index) => String.fromCharCode(0xAC00 + index)).join('\n');
  const box = { x: .1, y: .1, width: .02, height: .02 };
  const compactScene = { ...scene, title: '', text: value, composition: { ...scene.composition, body: box } };
  const dialogue = buildCompositionAss(compactScene, 1080, 1920).split('\n').filter(line => line.startsWith('Dialogue:'));
  assert.equal(dialogue.length, 1);
  const exported = dialogue[0].slice(dialogue[0].lastIndexOf(',,' ) + 2).replace(/^\{[^}]*\}/, '').replace(/\\N/g, '\n');
  assert.equal(exported, value);
  const fontSize = Number(dialogue[0].match(/\\fs([\d.]+)/)[1]);
  assert.ok(fontSize > 0 && fontSize <= box.width * 1080);
  assert.ok(exported.split('\n').length * (fontSize * 1.2) <= box.height * 1920);
});

test('fractional fitting preserves literal graphemes and blank paragraphs at strict bounds', () => {
  const box = { x: .1, y: .1, width: .02, height: .02 };
  for (const [cluster, advance] of [['\uD55C', 1], ['\u1100'.repeat(20), 20], ['\u2E3A', 2], ['\u2E3B', 3]]) {
    const value = (`{${cluster}}\\\r\n\n`).repeat(50);
    const expected = (`{${cluster}}\\\n\n`).repeat(50);
    for (const [width, height] of [[1080, 1920], [2, 2], [2, 1.9999999999999998]]) {
      for (const layer of ['title', 'body']) {
        const fitted = fitText(value, box, width, height, layer);
        assert.equal(fitted.text, expected);
        assert.ok(Number.isFinite(fitted.fontSize) && fitted.fontSize > 0);
        assert.ok(fitted.fontSize * advance <= box.width * width);
        assert.ok(fitted.text.split('\n').length * fitted.lineHeight <= box.height * height);
      }
    }
  }
});

const narrowBox = { x: .2, y: .1, width: .02, height: .5 };

function textScene(value, box = { x: .1, y: .1, width: .8, height: .8 }, layer = 'body') {
  return { ...scene, title: '', text: '', [layer === 'title' ? 'title' : 'text']: value,
    composition: { ...scene.composition, [layer]: box } };
}

// Compare actual libass pixels, independently of the fitting/serialization assertions.
function rasterizer(t) {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const filters = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true });
  if (filters.error?.code === 'ENOENT') { t.skip('FFmpeg is unavailable'); return; }
  assert.equal(filters.status, 0, filters.stderr);
  if (!/\bass\s+V->V/.test(filters.stdout)) { t.skip('FFmpeg has no libass filter'); return; }
  const directory = mkdtempSync(path.join(tmpdir(), 'frameforge-composition-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return script => {
    writeFileSync(path.join(directory, 'text.ass'), script);
    const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'color=c=black:s=1080x1920:d=1', '-vf', 'ass=text.ass', '-frames:v', '1', '-pix_fmt', 'gray',
      '-f', 'rawvideo', 'pipe:1'], { cwd: directory, windowsHide: true, maxBuffer: 4 * 1080 * 1920 });
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.equal(result.stdout.length, 1080 * 1920);
    return result.stdout;
  };
}

test('visible Arabic prepend format signs receive an advance budget in the exact 21.6px box', () => {
  for (const code of [0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06DD, 0x070F, 0x08E2]) {
    const value = String.fromCodePoint(code).repeat(20) + 'A';
    for (const layer of ['title', 'body']) {
      const fitted = fitText(value, narrowBox, 1080, 1920, layer);
      assert.equal(fitted.text, value);
      assert.ok(fitted.fontSize > 0 && fitted.fontSize * 21 <= 21.6,
        `U+${code.toString(16)} ${layer}: ${fitted.fontSize}px budgets fewer than 21 spacing glyphs`);
      const script = buildCompositionAss(textScene(value, narrowBox, layer), 1080, 1920);
      assert.ok(Number(script.match(/\\fs([\d.]+)/)[1]) * 21 <= 21.6);
    }
  }
});

test('libass keeps twenty U+0601 signs plus A inside x=216..237.6', t => {
  const rasterize = rasterizer(t);
  if (!rasterize) return;
  const value = '\u0601'.repeat(20) + 'A';
  for (const layer of ['title', 'body']) {
    const pixels = rasterize(buildCompositionAss(textScene(value, narrowBox, layer), 1080, 1920));
    let left = 1080, right = -1;
    for (let index = 0; index < pixels.length; index++) if (pixels[index] > 32) {
      left = Math.min(left, index % 1080); right = Math.max(right, index % 1080);
    }
    assert.ok(right >= left, 'the text must produce visible pixels');
    // Ignore dark outline/shadow pixels; allow one raster pixel at fractional edges.
    assert.ok(left >= 215 && right <= 238, `${layer}: glyph pixels x=${left}..${right}, expected 216..237.6`);
    t.diagnostic(`${layer}: glyph pixels x=${left}..${right}`);
  }
});

test('libass keeps visible fallback marks inside the narrow composition box', t => {
  const rasterize = rasterizer(t);
  if (!rasterize) return;
  for (const value of ['A\u20DD', 'A\u20DD\u20DD', 'A\u035C']) {
    for (const layer of ['title', 'body']) {
      const pixels = rasterize(buildCompositionAss(textScene(value, narrowBox, layer), 1080, 1920));
      let left = 1080, right = -1;
      for (let index = 0; index < pixels.length; index++) if (pixels[index] > 32) {
        left = Math.min(left, index % 1080); right = Math.max(right, index % 1080);
      }
      assert.ok(right >= left, 'authored text must produce visible pixels');
      assert.ok(left >= 215 && right <= 238,
        `${JSON.stringify(value)} ${layer}: glyph pixels x=${left}..${right}, expected 216..237.6`);
      assert.equal(fitText(value, narrowBox, 1080, 1920, layer).text, value);
      t.diagnostic(`${JSON.stringify(value)} ${layer}: glyph pixels x=${left}..${right}`);
    }
  }
});

test('composed accents, variation selectors, joiners and bidi controls retain their advance budget', () => {
  for (const value of ['e\u0301', 'A' + '\u200C'.repeat(20),
    'A' + '\u200D'.repeat(20), '\u2066A\u2069', '\u202AA\u202C', '\u200EA\u200F',
    '\u061CA', 'A\uFE0F']) {
    const fitted = fitText(value, narrowBox, 1080, 1920);
    assert.equal(fitted.text.replace(/\n/g, ''), value);
    assert.equal(fitted.fontSize, 21, JSON.stringify(value));
  }
});

for (const [label, value, expected] of [
  ['literal delimiters', 'a{b}\\c', 'a{b}\\c'],
  ['LF', 'first\nsecond', 'first\nsecond'],
  ['CRLF', 'first\r\nsecond', 'first\nsecond'],
  ['CR', 'first\rsecond', 'first\nsecond'],
  ['blank paragraphs', '\rfirst\r\n\rsecond\n', '\nfirst\n\nsecond\n'],
]) {
  test(`preview preserves ${label}`, () => {
    for (const layer of ['title', 'body']) {
      assert.equal(fitText(value, { x: .1, y: .1, width: .8, height: .8 }, 1080, 1920, layer).text, expected);
    }
  });
}

test('ASS serializes literal delimiters and paragraph breaks without enabling override tags', () => {
  const value = 'a{b}\\c\nfirst\r\nsecond\r{\\pos(0,0)}\\N\\n\\h';
  const script = buildCompositionAss(textScene(value), 1080, 1920);
  const dialogue = script.split('\n').find(line => line.startsWith('Dialogue:'));
  const payload = dialogue.slice(dialogue.indexOf('}') + 1);
  assert.equal(payload, 'a\\{b\\}\\\u2060c\\Nfirst\\Nsecond\\N\\{\\\u2060pos(0,0)\\}\\\u2060N\\\u2060n\\\u2060h');
  assert.ok(!payload.includes('{\\pos('));
});

test('libass renders literal braces and command-like backslashes with explicit blank paragraphs', t => {
  const rasterize = rasterizer(t);
  if (!rasterize) return;
  const value = '\ra{b}\\c\r\n\r{\\pos(0,0)}\\N\\n\\h\\\\\r';
  // Independently authored ASS fixture: BOM separates literal slashes from commands.
  // The live renderer probe verified BOM and WORD JOINER are both zero-advance.
  const expected = '\\Na\\{b\\}\\\uFEFFc\\N\\N\\{\\\uFEFFpos(0,0)\\}\\\uFEFFN\\\uFEFFn\\\uFEFFh\\\uFEFF\\\uFEFF\\N';
  for (const layer of ['title', 'body']) {
    const script = buildCompositionAss(textScene(value, { x: .1, y: .1, width: .8, height: .1 }, layer), 1080, 1920);
    const replacePayload = payload => script.replace(/(Dialogue:.*?\}).*/, (_, prefix) => prefix + payload);
    const pixels = rasterize(script);
    assert.ok(pixels.some(pixel => pixel > 32), 'literal text must remain visible');
    assert.ok(pixels.equals(rasterize(replacePayload(expected))), `${layer}: literal text or blank paragraphs changed`);
    assert.ok(!pixels.equals(rasterize(replacePayload('\\Na{b}\\c\\N\\N{\\pos(0,0)}\\N\\n\\h\\\\\\N'))),
      'the raw ASS commands must not match the literal-text render');
    t.diagnostic(`${layer}: literal-text pixels match the independently authored ASS fixture`);
  }
});

const slash=String.fromCharCode(92),cr=String.fromCharCode(13);
const subtitleLiteral=`a{b}${slash}c${cr}{${slash}pos(0,0)}`;
const videoSlot={id:'video',role:'video-bg',x:0,y:0,w:100,h:100,zIndex:1,assetUrl:scene.assetUrl,mediaKind:'image'};
const textPayload=ass=>{
  const line=ass.split(String.fromCharCode(10)).find(item=>item.startsWith('Dialogue:'));
  const raw=line.slice(line.lastIndexOf(',,')+2);
  return raw.startsWith('{')?raw.slice(raw.indexOf('}')+1):raw;
};

test('slot-based ASS global captions preserve literal delimiters and paragraph breaks', () => {
  const current={...scene,title:'',text:subtitleLiteral,slots:[videoSlot]};
  const plan=buildSceneCompositionPlan(current,1080,1920);
  const expected=buildCompositionAss({...scene,title:'',text:subtitleLiteral},1080,1920);
  assert.equal(textPayload(plan.globalAss),textPayload(expected));
});

test('slot-based ASS text preserves literal delimiters and paragraph breaks', () => {
  const current={...scene,title:'',text:'',slots:[videoSlot,{id:'copy',role:'subtitle-layer',x:0,y:0,w:100,h:100,zIndex:2,text:subtitleLiteral}]};
  const plan=buildSceneCompositionPlan(current,1080,1920);
  const expected=buildCompositionAss({...scene,title:'',text:subtitleLiteral},1080,1920);
  assert.equal(textPayload(plan.slotAss[1]),textPayload(expected));
});

test('normal-size fitting retains the largest fitting integer candidate', () => {
  const box = { x: .1, y: .1, width: .84, height: .26 };
  for (const [layer, expected] of [['title', 61], ['body', 47]]) {
    const fitted = fitText('Hello', box, 1080, 1920, layer);
    assert.equal(fitted.text, 'Hello');
    assert.equal(fitted.fontSize, expected);
  }
});

test('slot scenes retain full-frame base media despite earlier composition geometry', () => {
  const slots = [{ id: 'overlay', role: 'html-overlay', x: 4, y: 3, w: 92, h: 12, zIndex: 8, text: 'Independent slot' }];
  const current = { ...scene, slots };
  assert.equal(buildSceneMediaFilter(current, 1080, 1920), 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=#123456');
  assert.equal(buildSceneMediaFilter({ ...current, layout: 'split' }, 1080, 1920), 'scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:0:color=#123456');
  assert.equal(buildSceneMediaFilter({ ...current, assetUrl: undefined }, 1080, 1920), 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=#123456');
  assert.equal(buildSceneMediaFilter({ ...current, slots: [] }, 1080, 1920), buildCompositionMediaFilter(scene, 1080, 1920));
});

// Chromium at 100px with the actual preview font stack (Segoe UI / Pretendard /
// Noto Sans KR / Malgun Gothic / Apple SD Gothic Neo / sans-serif) measured:
// U+0BF5=2.2744140625em, U+0BF8=2.0283203125em, U+0DF4=1.89208984375em.
// Round these independently observed fallback advances upward;
// U+0BF5 deliberately receives at least three em rather than one cell.
for (const [code, advance] of [[0x0BF5, 3], [0x0BF8, 3], [0x0DF4, 2]]) {
  const label = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  const value = String.fromCodePoint(code);
  test(`wide fallback ${label} fits the preview width budget without losing text`, () => {
    for (const layer of ['title', 'body']) {
      const fitted = fitText(value, narrowBox, 1080, 1920, layer);
      assert.equal(fitted.text, value, `${label} ${layer}: source text must survive fitting`);
      assert.ok(fitted.fontSize > 0 && fitted.fontSize * advance <= 21.6,
        `${label} ${layer}: preview ${fitted.fontSize}px * ${advance}em exceeds 21.6px`);
    }
  });

  test(`wide fallback ${label} uses a safe fitted ASS size without losing text`, () => {
    for (const layer of ['title', 'body']) {
      const script = buildCompositionAss(textScene(value, narrowBox, layer), 1080, 1920);
      assert.equal(textPayload(script), value, `${label} ${layer}: ASS must retain source text`);
      const size = Number(script.match(/\\fs([\d.]+)/)[1]);
      assert.ok(size > 0 && size * advance <= 21.6,
        `${label} ${layer}: ASS ${size}px * ${advance}em exceeds 21.6px`);
    }
  });

  test(`libass keeps wide fallback ${label} pixels inside x=216..237.6`, t => {
    const rasterize = rasterizer(t);
    if (!rasterize) return;
    for (const layer of ['title', 'body']) {
      const pixels = rasterize(buildCompositionAss(textScene(value, narrowBox, layer), 1080, 1920));
      let left = 1080, right = -1;
      for (let index = 0; index < pixels.length; index++) if (pixels[index] > 32) {
        left = Math.min(left, index % 1080); right = Math.max(right, index % 1080);
      }
      assert.ok(right >= left, `${label} ${layer}: authored text must produce visible pixels`);
      assert.ok(left >= 215 && right <= 238,
        `${label} ${layer}: glyph pixels x=${left}..${right}, expected 216..237.6`);
      t.diagnostic(`${label} ${layer}: glyph pixels x=${left}..${right}`);
    }
  });
}

const authoredParagraphs = '\n  A\r\n\r B \n';
const authoredAssParagraphs = '\\N  A\\N\\N B \\N';
for (const layer of ['title', 'body']) {
  test(`ASS preserves boundary spaces and blank paragraphs in authored scene ${layer}`, () => {
    assert.equal(textPayload(buildCompositionAss(textScene(authoredParagraphs, undefined, layer), 1080, 1920)), authoredAssParagraphs);
  });
}

test('ASS preserves boundary spaces and blank paragraphs in slot-scene global text', () => {
  const plan = buildSceneCompositionPlan({ ...scene, title: '', text: authoredParagraphs, slots: [videoSlot] }, 1080, 1920);
  assert.equal(textPayload(plan.globalAss), authoredAssParagraphs);
});

test('ASS preserves boundary spaces and blank paragraphs in authored slot text', () => {
  const slot = { id: 'copy', role: 'subtitle-layer', x: 0, y: 0, w: 100, h: 100, zIndex: 2, text: authoredParagraphs };
  const plan = buildSceneCompositionPlan({ ...scene, title: '', text: '', slots: [videoSlot, slot] }, 1080, 1920);
  assert.equal(textPayload(plan.slotAss[1]), authoredAssParagraphs,
    'slot export must preserve authored boundary spaces and blank paragraphs');
});

test('ASS preserves explicit boundary blank paragraphs in HTML-derived slot text', () => {
  const slot = { id: 'html', role: 'html-overlay', x: 0, y: 0, w: 100, h: 100, zIndex: 2,
    html: '<br><br>A<br><br>B<br><br>' };
  const plan = buildSceneCompositionPlan({ ...scene, title: '', text: '', slots: [videoSlot, slot] }, 1080, 1920);
  assert.equal(textPayload(plan.slotAss[1]), '\\N\\NA\\N\\NB\\N\\N',
    'HTML-derived slot export must preserve every explicit blank paragraph');
});

test('ASS preserves explicit block paragraph breaks and spaces while stripping inline markup', () => {
  const slot = { id: 'html-blocks', role: 'html-overlay', x: 0, y: 0, w: 100, h: 100, zIndex: 2,
    html: '<p><b>  A </b></p><p></p><div> B  </div>' };
  const plan = buildSceneCompositionPlan({ ...scene, title: '', text: '', slots: [videoSlot, slot] }, 1080, 1920);
  assert.equal(textPayload(plan.slotAss[1]), '  A \\N\\N B  \\N');
});
