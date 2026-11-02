import { mkdir, writeFile, realpath, rm, copyFile, open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, constants } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { execute, executeWithStreams } from './process.mjs';
import { requiredMediaCredits } from './media-credits.mjs';
import { sceneCaptions, episodeMusic } from './validation.mjs';
import { canonicalJson } from './graph.mjs';

export const dimensions = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] };
const MEDIA_FORMATS = {
  '.mp4': 'mov', '.mov': 'mov', '.webm': 'matroska,webm',
  '.png': 'png_pipe', '.jpg': 'jpeg_pipe', '.jpeg': 'jpeg_pipe',
  '.webp': 'webp_pipe', '.gif': 'gif',
  '.mp3': 'mp3', '.wav': 'wav', '.ogg': 'ogg',
};

// A contained filename can still disguise a playlist referencing files outside uploads.
// Apply to every untrusted input, including the audio probe; never permit playlist demuxers.
export function localMediaInputOptions(filename) {
  const formats = MEDIA_FORMATS[path.extname(filename).toLowerCase()];
  if (!formats) throw new Error('Unsupported uploaded media format');
  return ['-protocol_whitelist', 'file', '-format_whitelist', formats];
}

function wrapSubtitleLine(line, width) {
  const limit = Math.max(1, Math.floor(Number(width) || 1));
  const words = line.trim().split(/\s+/u).filter(Boolean);
  const rows = [];
  let row = '';
  for (const word of words) {
    const wordLength = Array.from(word).length;
    if (wordLength > limit) {
      if (row) { rows.push(row); row = ''; }
      const chars = Array.from(word);
      while (chars.length > limit) rows.push(chars.splice(0, limit).join(''));
      row = chars.join('');
      continue;
    }
    if (row && Array.from(row).length + 1 + wordLength > limit) { rows.push(row); row = word; }
    else row = row ? `${row} ${word}` : word;
  }
  if (row) rows.push(row);
  return rows.length ? rows : [''];
}

function subtitleText(text, width) {
  const cleaned = String(text || '').replace(/[{}\\]/g, '').replace(/\r/g, '');
  return cleaned.split('\n').flatMap(line => wrapSubtitleLine(line, width)).join('\\N');
}

function captionText(text, width) {
  return String(text || '').replace(/\r/g, '').split('\n').flatMap((line) => wrapSubtitleLine(line, width).map(row => row.replace(/\\/g, '\\\u200b').replace(/[{}]/g, '\\$&'))).join('\\N');
}

function assTime(seconds) {
  const centiseconds = Math.round(seconds * 100);
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor(centiseconds / 6000) % 60;
  const wholeSeconds = Math.floor(centiseconds / 100) % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

function hexToAssColor(hex = '#ffffff', alpha = 0) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255))).toString(16).padStart(2, '0').toUpperCase();
  if (!match) return `&H${a}FFFFFF`;
  const [, r, g, b] = match;
  return `&H${a}${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
}

function stripHtmlTags(html = '') {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function mediaCreditPlan(scene, w, h) {
  const credits = requiredMediaCredits([scene]);
  if (!credits) return null;
  const fontSize = 28, padding = 32, lineSpacing = 8;
  // Count every code point as a full em, including URLs without word boundaries.
  // This conservative wrap also accommodates CJK glyphs at the same readable size.
  const columns = Math.floor((w - padding * 2) / fontSize);
  const lines = credits.split(/\r?\n/).flatMap((line) => {
    const characters = Array.from(line.replace(/\t/g, '    '));
    const rows = [];
    while (characters.length) rows.push(characters.splice(0, columns).join(''));
    return rows.length ? rows : [''];
  });
  const height = Math.ceil((lines.length * (fontSize + lineSpacing) + padding) / 2) * 2;
  if (height > h * 0.45) throw new Error('Required media credits do not fit legibly in this scene; shorten the credit text or separate the credited assets before rendering');
  return { text: lines.join('\n'), height, fontSize, lineSpacing, padding, contentHeight: h - height };
}

function visualInputOptions(source, mediaOptions, isImage, trimStart = 0, trimEnd) {
  if (!Number.isFinite(trimStart) || trimStart < 0 || trimStart > 36000 || (trimEnd !== undefined && (!Number.isFinite(trimEnd) || trimEnd <= trimStart || trimEnd > 36000))) throw new Error('Invalid media trim');
  return isImage
    ? [...mediaOptions, '-stream_loop', '-1', '-i', source]
    : [...mediaOptions, '-ss', String(trimStart), ...(trimEnd !== undefined ? ['-t', String(trimEnd - trimStart)] : []), '-i', source];
}

export function buildSceneCompositionPlan(scene, w, h) {
  const slots = Array.isArray(scene.slots) ? [...scene.slots].sort((a, b) => (Number(a.zIndex) || 0) - (Number(b.zIndex) || 0)) : [];
  const captions = sceneCaptions(scene.captions, scene.duration);
  const captionSlot = slots.findIndex((slot) => slot.role === 'subtitle-layer');
  const font = process.platform === 'win32' ? 'Malgun Gothic' : 'Noto Sans CJK KR';
  const alignment = scene.layout === 'lower-third' ? 2 : 5;
  const margin = scene.layout === 'lower-third' ? Math.round(h * 0.16) : 80;
  const styles = [
    `Style: Default,${font},${w > h ? 64 : 62},&H00FFFFFF,&H000000FF,&H00101010,&H90000000,-1,0,0,0,100,100,0,0,1,3,2,${alignment},90,90,${margin},1`,
  ];
  const dialogues = [];
  const globalDialogues = [];
  const slotDialogues = new Map();
  if (captions !== undefined) {
    if (captionSlot < 0) {
      for (const cue of captions) globalDialogues.push(`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${captionText(cue.text, w > h ? 34 : 17)}`);
    }
  } else if (!slots.length || (scene.text && !slots.some((slot) => ['subtitle-layer', 'text-overlay'].includes(slot.role) && slot.text))) {
    globalDialogues.push(`Dialogue: 0,0:00:00.00,0:10:00.00,Default,,0,0,0,,${subtitleText(scene.text, w > h ? 34 : 17)}`);
  }

  const slotBoxes = [];
  slots.forEach((slot, index) => {
    const sx = Math.max(0, Math.min(w - 4, Math.round((Number(slot.x || 0) / 100) * w)));
    const sy = Math.max(0, Math.min(h - 4, Math.round((Number(slot.y || 0) / 100) * h)));
    const sw = Math.max(4, Math.min(w - sx, Math.max(4, Math.floor(((Number(slot.w || 50) / 100) * w) / 2) * 2)));
    const sh = Math.max(4, Math.min(h - sy, Math.max(4, Math.floor(((Number(slot.h || 20) / 100) * h) / 2) * 2)));
    const cx = Math.round(sx + sw / 2);
    const cy = Math.round(sy + sh / 2);
    const styleName = `Slot${index}`;
    const fontSize = Math.max(16, Math.min(120, Math.round(Number(slot.style?.fontSize) || (slot.role === 'subtitle-layer' ? 44 : 36))));
    const primaryColor = hexToAssColor(slot.style?.textColor || '#ffffff', 0);
    const backColor = hexToAssColor(slot.style?.backgroundColor || '#101010', 1 - Math.max(0, Math.min(1, Number(slot.style?.opacity ?? 0.8))));
    styles.push(`Style: ${styleName},${font},${fontSize},${primaryColor},&H000000FF,&H00101010,${backColor},-1,0,0,0,100,100,0,0,1,3,1,5,20,20,20,1`);

    const copySource = slot.text || (slot.html ? stripHtmlTags(slot.html) : '') || (slot.dataBinding === 'scene.title' ? scene.title : slot.dataBinding === 'scene.narration' ? (scene.narration || scene.text) : slot.dataBinding === 'scene.text' ? scene.text : '');
    const badgePrefix = slot.style?.badge ? `[${slot.style.badge}] ` : '';
    const combinedText = `${badgePrefix}${copySource || ''}`.trim();
    if (captions !== undefined && index === captionSlot) {
      if (captions.length) {
        const charCols = Math.max(8, Math.round((sw / w) * (w > h ? 36 : 18)));
        const slotAlign = slot.style?.align === 'left' ? 4 : slot.style?.align === 'right' ? 6 : 5;
        const textX = slotAlign === 4 ? sx + 12 : slotAlign === 6 ? sx + sw - 12 : cx;
        const events = captions.map((cue) => `Dialogue: ${Math.max(1, Number(slot.zIndex) || index + 1)},${assTime(cue.start)},${assTime(cue.end)},${styleName},,0,0,0,,{\\an${slotAlign}\\pos(${textX},${cy})}${captionText(`${badgePrefix}${cue.text}`, charCols)}`);
        dialogues.push(...events);
        slotDialogues.set(index, events);
      }
    } else if (combinedText) {
      const charCols = Math.max(8, Math.round((sw / w) * (w > h ? 36 : 18)));
      const slotAlign = slot.style?.align === 'left' ? 4 : slot.style?.align === 'right' ? 6 : 5;
      const textX = slotAlign === 4 ? sx + 12 : slotAlign === 6 ? sx + sw - 12 : cx;
      const textDialogue = `Dialogue: ${Math.max(1, Number(slot.zIndex) || index + 1)},0:00:00.00,0:10:00.00,${styleName},,0,0,0,,{\\an${slotAlign}\\pos(${textX},${cy})}${subtitleText(combinedText, charCols)}`;
      dialogues.push(textDialogue);
      slotDialogues.set(index, [textDialogue]);
    }

    slotBoxes.push({
      index,
      slot,
      sx,
      sy,
      sw,
      sh,
      cx,
      cy,
      hasAsset: Boolean(slot.assetUrl),
      backgroundColor: /^#[0-9a-fA-F]{6}$/.test(slot.style?.backgroundColor || '') ? slot.style.backgroundColor : null,
      opacity: Math.max(0.1, Math.min(1, Number(slot.style?.opacity ?? 0.82))),
    });
  });

  dialogues.unshift(...globalDialogues);
  const makeAss = (events) => `[Script Info]\nScriptType: v4.00\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${styles.join('\n')}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
  const slotAss = Object.fromEntries([...slotDialogues.entries()].map(([index, events]) => [index, makeAss(events)]));
  return { ass: makeAss(dialogues), globalAss: globalDialogues.length ? makeAss(globalDialogues) : '', slotAss, slotBoxes: slotBoxes.map((box) => slotAss[box.index] ? { ...box, textAss: slotAss[box.index] } : box), hasSlots: slots.length > 0, credits: mediaCreditPlan(scene, w, h) };
}

async function resolveVerifiedUpload(root, assetUrl) {
  const match = /^\/api\/uploads\/([a-zA-Z0-9_.-]+)$/.exec(assetUrl);
  if (!match || match[1].includes('..')) throw new Error('Only uploaded local media can be rendered');
  const uploadRoot = await realpath(path.join(root, 'uploads'));
  const source = await realpath(path.join(uploadRoot, match[1]));
  if (path.dirname(source) !== uploadRoot) throw new Error('Media path escapes uploads');
  const mediaOptions = localMediaInputOptions(source);
  return { source, mediaOptions };
}

async function sceneInput(root, assetUrl, receipt, pipeNumber) {
  const match = /^\/api\/uploads\/([a-zA-Z0-9_-]+\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|ogg))$/i.exec(assetUrl || '');
  if (!match) throw new Error('Invalid scene media upload');
  const declared = path.resolve(root, 'uploads'), directory = await realpath(declared);
  const normalized = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalized(directory) !== normalized(declared) || (await lstat(declared)).isSymbolicLink()) throw new Error('Unsafe scene media directory');
  const filename = path.join(directory, match[1]), before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || normalized(await realpath(filename)) !== normalized(filename) || before.size < 1 || before.size > 100 * 1024 * 1024) throw new Error('Unsafe scene media file');
  const formats = MEDIA_FORMATS[path.extname(filename).toLowerCase()];
  let completed;
  return {
    source: `cache:pipe:${pipeNumber}`,
    mediaOptions: ['-protocol_whitelist', 'cache,pipe', '-format_whitelist', formats, '-read_ahead_limit', '-1'],
    feed: async (pipe) => {
      const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (!opened.isFile() || !sameMusicFile(before, opened)) { await handle.close(); throw new Error('Scene media changed while opening'); }
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      try {
        while (offset < before.size) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
          if (!bytesRead) throw new Error('Scene media changed while reading');
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          if (pipe.destroyed || !await new Promise((resolve) => pipe.write(chunk, (error) => resolve(!error)))) throw new Error('Scene media pipe closed before all verified bytes were delivered');
          offset += bytesRead;
        }
        if (!pipe.destroyed) pipe.end();
        const final = await handle.stat(), after = await lstat(filename);
        if (!after.isFile() || after.isSymbolicLink() || !sameMusicFile(before, after) || !sameMusicFile(opened, final) || normalized(await realpath(filename)) !== normalized(filename)) throw new Error('Scene media changed while rendering');
        completed = { ...receipt, assetUrl, sha256: hash.digest('hex'), size: offset };
      } finally { await handle.close(); if (!pipe.destroyed) pipe.end(); }
    },
    result: () => { if (!completed) throw new Error('Scene media input was not verified'); return completed; },
  };
}

function musicIntegrityError() {
  return Object.assign(new Error('Music upload integrity check failed'), { code: 'MUSIC_INTEGRITY' });
}
function classifyMusicInputError(error, expected) {
  if (expected && (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error?.code) || error?.message === 'Media path escapes uploads')) return musicIntegrityError();
  return error;
}


function sameMusicFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function snapshotMusic(root, music, expected) {
  const declaredRoot = path.join(root, 'uploads');
  const uploadRoot = await realpath(declaredRoot);
  const normalized = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalized(uploadRoot) !== normalized(declaredRoot) || (await lstat(declaredRoot)).isSymbolicLink()) throw musicIntegrityError();
  const filename = path.basename(music.assetUrl), source = path.join(uploadRoot, filename);
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || normalized(await realpath(source)) !== normalized(source) || before.size < 1 || before.size > 100 * 1024 * 1024) throw musicIntegrityError();
  if (expected && (!/^[a-f0-9]{64}$/.test(expected.sha256 || '') || !Number.isSafeInteger(expected.size) || expected.size !== before.size)) throw musicIntegrityError();
  if (music.source.sha256 !== undefined && (typeof music.source.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(music.source.sha256))) throw musicIntegrityError();
  // FFmpeg consumes these verified bytes from stdin. It never reopens a replaceable
  // snapshot path; the allocation is bounded by the same 100 MiB upload limit.
  const bytes = Buffer.allocUnsafe(before.size);
  let digest;
  let input;
  try {
    input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await input.stat();
    if (!opened.isFile() || !sameMusicFile(before, opened)) throw musicIntegrityError();
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await input.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!bytesRead) throw musicIntegrityError();
      hash.update(bytes.subarray(offset, offset + bytesRead));
      offset += bytesRead;
    }
    const final = await input.stat(), after = await lstat(source);
    digest = hash.digest('hex');
    if (!after.isFile() || after.isSymbolicLink() || !sameMusicFile(before, after) || !sameMusicFile(opened, final) || normalized(await realpath(source)) !== normalized(source) || (expected && digest !== expected.sha256) || (music.source.sha256 && digest !== music.source.sha256.toLowerCase())) throw musicIntegrityError();
  } finally {
    await input?.close();
  }
  const format = path.extname(filename).slice(1).toLowerCase();
  return { source: 'pipe:0', input: bytes, mediaOptions: ['-protocol_whitelist', 'pipe', '-format_whitelist', MEDIA_FORMATS[`.${format}`], '-f', format], verifiedMusicIntegrity: { sha256: digest, size: bytes.length } };
}

export async function renderEpisode(episode, { dataDir, musicIntegrity, sceneIntegrity, onProgress = () => {} }) {
  if (!dimensions[episode.format] || !episode.scenes?.length || episode.scenes.length > 60) throw new Error('Invalid render timeline');
  const [w, h] = dimensions[episode.format];
  const root = path.resolve(dataDir), name = `${randomUUID()}.mp4`;
  const temp = path.join(root, 'render-work', randomUUID());
  await mkdir(temp, { recursive: true });
  await mkdir(path.join(root, 'exports'), { recursive: true });
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    const music = episodeMusic(episode.music);
    const verifiedScenes = Boolean(music) || sceneIntegrity !== undefined;
    let musicInput = null;
    if (music) {
      try { musicInput = await resolveVerifiedUpload(root, music.assetUrl); }
      catch (error) { throw classifyMusicInputError(error, musicIntegrity); }
    }
    if (music) {
      const duration = episode.scenes.reduce((total, scene) => total + Number(scene.duration), 0);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 1800 || music.start >= duration) throw new Error('Invalid music placement outside episode timeline');
      try { musicInput = await snapshotMusic(root, music, musicIntegrity); }
      catch (error) { throw classifyMusicInputError(error, musicIntegrity); }
    }
    const verifiedSceneAssets = [];
    for (let i = 0; i < episode.scenes.length; i++) {
      const scene = episode.scenes[i], duration = Number(scene.duration);
      const streamInputs = [];
      let probedAsset;
      const streamFor = async (url, identity) => {
        const entry = await sceneInput(root, url, identity, streamInputs.length + 3);
        streamInputs.push(entry);
        return entry;
      };
      if (!(duration >= 0.25 && duration <= 120) || !/^#[\da-f]{6}$/i.test(scene.background)) throw new Error('Invalid scene duration/color');
      const plan = buildSceneCompositionPlan(scene, w, h);
      if (plan.credits) {
        await writeFile(path.join(temp, `scene-${i}-credits.txt`), plan.credits.text);
        // Windows FFmpeg builds may have no Fontconfig configuration. An explicit
        // local font file avoids that global dependency and requires no setup.
        if (process.platform === 'win32') await copyFile(path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'malgun.ttf'), path.join(temp, 'credit-font.ttf'));
      }
      await writeFile(path.join(temp, `scene-${i}.ass`), plan.ass);
      if (plan.globalAss) await writeFile(path.join(temp, `scene-${i}-global.ass`), plan.globalAss);
      for (const [slotIndex, slotAss] of Object.entries(plan.slotAss || {})) await writeFile(path.join(temp, `scene-${i}-slot-${slotIndex}.ass`), slotAss);
      let input = ['-f', 'lavfi', '-i', `color=c=${scene.background}:s=${w}x${h}:r=30:d=${duration}`];
      let mediaAudio = false;
      const trimStart = Number(scene.trimStart || 0), audioVolume = Number(scene.audioVolume ?? 1);
      if (!Number.isFinite(trimStart) || trimStart < 0 || trimStart > 36000 || !Number.isFinite(audioVolume) || audioVolume < 0 || audioVolume > 2) throw new Error('Invalid trim/audio volume');
      if (scene.trimEnd !== undefined && (!Number.isFinite(scene.trimEnd) || scene.trimEnd <= trimStart || scene.trimEnd > 36000)) throw new Error('Invalid media trim');
      if (scene.assetUrl) {
        const identity = { sceneId: scene.id, use: 'asset' };
        const { source, mediaOptions } = verifiedScenes ? await streamFor(scene.assetUrl, identity) : await resolveVerifiedUpload(root, scene.assetUrl);
        input = visualInputOptions(source, mediaOptions, scene.kind === 'image', trimStart, scene.trimEnd);
        if (scene.kind === 'video') {
          let probe;
          if (verifiedScenes) {
            const verifiedProbe = await sceneInput(root, scene.assetUrl, identity, 3);
            probe = await executeWithStreams(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', ...verifiedProbe.mediaOptions, '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', verifiedProbe.source], { timeout: 15000, streams: [verifiedProbe.feed] });
            probedAsset = verifiedProbe.result();
          } else {
            probe = await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', ...mediaOptions, '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', source], { timeout: 15000 });
          }
          mediaAudio = probe.stdout.trim() === 'audio';
        }
      }

      const slotInputs = [];
      for (const box of plan.slotBoxes) {
        if (!box.hasAsset) continue;
        const { source, mediaOptions } = verifiedScenes ? await streamFor(box.slot.assetUrl, { sceneId: scene.id, slotId: box.slot.id, use: 'asset' }) : await resolveVerifiedUpload(root, box.slot.assetUrl);
        const isImage = box.slot.mediaKind === 'image' || /\.(?:png|jpe?g|webp|gif)$/i.test(box.slot.assetUrl);
        slotInputs.push({
          ...box,
          isImage,
          args: visualInputOptions(source, mediaOptions, isImage, box.slot.trimStart ?? 0, box.slot.trimEnd),
        });
      }

      const base = scene.layout === 'split' && scene.assetUrl
        ? `scale=${w}:${Math.round(h / 2)}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:0:color=${scene.background}`
        : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${scene.background}`;

      let audioInput = ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
      const audioInputIndex = 1 + slotInputs.length;
      let audioMap = mediaAudio ? '0:a:0' : `${audioInputIndex}:a:0`;
      if (scene.audioUrl) {
        if (verifiedScenes) {
          const verified = await streamFor(scene.audioUrl, { sceneId: scene.id, use: 'audio' });
          audioInput = [...verified.mediaOptions, '-i', verified.source];
        } else {
          const match = /^\/api\/uploads\/([a-zA-Z0-9_-]+\.(?:mp3|wav|ogg))$/.exec(scene.audioUrl);
          if (!match) throw new Error('Invalid audio upload');
          const uploadRoot = await realpath(path.join(root, 'uploads'));
          const source = await realpath(path.join(uploadRoot, match[1]));
          if (path.dirname(source) !== uploadRoot) throw new Error('Audio path escapes uploads');
          audioInput = [...localMediaInputOptions(source), '-i', source];
        }
        audioMap = `${audioInputIndex}:a:0`;
      }

      let filterArgs;
      let videoMap = '0:v:0';
      // Compose the authored image/captions first, then fit that complete picture above
      // an opaque credit band. Credits can never cover a caption or be hidden by a slot.
      const creditFilter = plan.credits
        ? `,scale=${w}:${plan.credits.contentHeight}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:0:color=black,setsar=1,drawtext=textfile=scene-${i}-credits.txt:expansion=none:${process.platform === 'win32' ? 'fontfile=credit-font.ttf' : "font='Noto Sans CJK KR'"}:fontsize=${plan.credits.fontSize}:fontcolor=white:line_spacing=${plan.credits.lineSpacing}:x=${plan.credits.padding}:y=${plan.credits.contentHeight + plan.credits.padding / 2}`
        : '';
      if (!plan.hasSlots) {
        const filter = `${base},setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=${duration},subtitles=scene-${i}.ass${creditFilter}`;
        filterArgs = ['-vf', filter];
      } else {
        const chains = [`[0:v]${base},setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=${duration}[v0]`];
        let currentLabel = 'v0';
        let stepCounter = 0;
        let slotInputCounter = 1;
        const nextLabel = () => `vstep${++stepCounter}`;
        for (const box of plan.slotBoxes) {
          if (box.hasAsset) {
            const inIdx = slotInputCounter++;
            const slotLabel = `slotv${stepCounter}`;
            const visualLabel = nextLabel();
            const padColor = box.backgroundColor || scene.background;
            chains.push(`[${inIdx}:v]scale=${box.sw}:${box.sh}:force_original_aspect_ratio=decrease,pad=${box.sw}:${box.sh}:(ow-iw)/2:(oh-ih)/2:color=${padColor},setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=${duration}[${slotLabel}]`);
            chains.push(`[${currentLabel}][${slotLabel}]overlay=x=${box.sx}:y=${box.sy}:eof_action=pass[${visualLabel}]`);
            currentLabel = visualLabel;
          } else if (box.backgroundColor) {
            const visualLabel = nextLabel();
            chains.push(`[${currentLabel}]drawbox=x=${box.sx}:y=${box.sy}:w=${box.sw}:h=${box.sh}:color=${box.backgroundColor}@${box.opacity.toFixed(2)}:t=fill[${visualLabel}]`);
            currentLabel = visualLabel;
          }
          if (box.textAss) {
            const textLabel = nextLabel();
            chains.push(`[${currentLabel}]subtitles=scene-${i}-slot-${box.index}.ass[${textLabel}]`);
            currentLabel = textLabel;
          }
        }
        if (plan.globalAss) {
          const globalLabel = nextLabel();
          chains.push(`[${currentLabel}]subtitles=scene-${i}-global.ass[${globalLabel}]`);
          currentLabel = globalLabel;
        }
        chains.push(`[${currentLabel}]null${creditFilter}[vout]`);
        filterArgs = ['-filter_complex', chains.join(';')];
        videoMap = '[vout]';
      }

      const allInputs = [...input, ...slotInputs.flatMap((item) => item.args), ...audioInput];
      const args = ['-hide_banner', '-loglevel', 'error', '-y', ...allInputs, '-map', videoMap, '-map', audioMap, ...filterArgs, '-af', `volume=${audioVolume},apad`, '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-threads', '2', `segment-${i}.mp4`];
      if (streamInputs.length) {
        await executeWithStreams(ffmpeg, args, { cwd: temp, timeout: 300000, streams: streamInputs.map((entry) => entry.feed) });
        const sceneReceipts = streamInputs.map((entry) => entry.result());
        if (probedAsset && (sceneReceipts[0].sha256 !== probedAsset.sha256 || sceneReceipts[0].size !== probedAsset.size)) throw new Error('Scene media changed between probe and render');
        verifiedSceneAssets.push(...sceneReceipts);
      } else {
        await execute(ffmpeg, args, { cwd: temp, timeout: 300000 });
      }
      onProgress(Math.round((i + 1) / episode.scenes.length * 90));
    }
    await writeFile(path.join(temp, 'concat.txt'), episode.scenes.map((_, i) => `file 'segment-${i}.mp4'`).join('\n'));
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-c', 'copy', '-movflags', '+faststart', music ? 'joined.mp4' : 'final.mp4'], { cwd: temp });
    if (music) {
      const delaySamples = Math.round(music.start * 48000);
      const filters = `[1:a:0]atrim=start=${music.trimStart},asetpts=PTS-STARTPTS,aresample=48000,volume=${music.volume},adelay=${delaySamples}S:all=1[music];[0:a:0][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.9:level=disabled:latency=1[aout]`;
      await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'joined.mp4', ...musicInput.mediaOptions, '-i', musicInput.source, '-filter_complex', filters, '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', 'final.mp4'], { cwd: temp, input: musicInput.input, timeout: 300000 });
    }
    if (sceneIntegrity !== undefined) {
      const ordered = (values) => values.map((value) => canonicalJson(value)).sort();
      if (!Array.isArray(sceneIntegrity) || canonicalJson(ordered(sceneIntegrity)) !== canonicalJson(ordered(verifiedSceneAssets))) throw new Error('Scene upload integrity check failed');
    }
    await copyFile(path.join(temp, 'final.mp4'), path.join(root, 'exports', name));
    onProgress(100);
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path.join(root, 'exports', name))) digest.update(chunk);
    return { filename: name, outputUrl: `/api/exports/${name}`, sha256: digest.digest('hex'), ...(musicInput ? { verifiedMusicIntegrity: musicInput.verifiedMusicIntegrity } : {}), ...(verifiedScenes ? { verifiedSceneAssets } : {}) };
  } finally {
    const actualParent = await realpath(path.join(root, 'render-work'));
    const actualTemp = await realpath(temp);
    if (path.dirname(actualTemp) !== actualParent) throw new Error('Unsafe render cleanup path');
    await rm(actualTemp, { recursive: true, force: true });
  }
}
