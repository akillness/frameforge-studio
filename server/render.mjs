import { mkdir, writeFile, realpath, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { execute } from './process.mjs';
import { composition } from './validation.mjs';
import { fitText } from '../public/composition.js';

export const dimensions = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] };
const MEDIA_FORMATS = {
  '.mp4': 'mov', '.mov': 'mov', '.webm': 'matroska,webm',
  '.png': 'png_pipe', '.jpg': 'jpeg_pipe', '.jpeg': 'jpeg_pipe',
  '.webp': 'webp_pipe', '.gif': 'gif',
  '.mp3': 'mp3', '.wav': 'wav', '.ogg': 'ogg',
};

function escapeAssText(text) {
  // libass does not escape backslashes by doubling them: \\N still breaks a line.
  // A zero-advance WORD JOINER prevents command recognition after a literal slash.
  return text.replace(/\\/g, '\\\u2060').replace(/[{}]/g, '\\$&').replace(/\n/g, '\\N');
}

// A contained filename can still disguise a playlist referencing files outside uploads.
// Apply to every untrusted input, including the audio probe; never permit playlist demuxers.
export function localMediaInputOptions(filename) {
  const formats = MEDIA_FORMATS[path.extname(filename).toLowerCase()];
  if (!formats) throw new Error('Unsupported uploaded media format');
  return ['-protocol_whitelist', 'file', '-format_whitelist', formats];
}

function subtitleText(text, width) {
  const lf=String.fromCharCode(10),cr=String.fromCharCode(13);
  const cleaned=String(text||'').split(cr+lf).join(lf).split(cr).join(lf);
  const wrapped=cleaned.split(lf).flatMap(line=>{
    const chars=Array.from(line),rows=[];
    while(chars.length) rows.push(chars.splice(0,width).join(''));
    return rows.length?rows:[''];
  }).join(lf);
  return escapeAssText(wrapped);
}

export function buildCompositionMediaFilter(scene, w, h) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2) throw new Error('Invalid composition canvas');
  if (typeof scene.background !== 'string' || !/^#[\da-f]{6}$/i.test(scene.background)) throw new Error('Invalid scene background');
  const box = composition(scene.composition, scene.layout).media;
  const alignEven = value => Math.max(2, Math.round(value / 2) * 2);
  const mw = Math.min(w - (w % 2), alignEven(w * box.width)), mh = Math.min(h - (h % 2), alignEven(h * box.height));
  const alignOffset = value => Math.max(0, Math.floor(value / 2) * 2);
  const x = Math.min(w - mw, alignOffset(w * box.x));
  const y = Math.min(h - mh, alignOffset(h * box.y));
  return `scale=${mw}:${mh}:force_original_aspect_ratio=decrease,pad=${mw}:${mh}:(ow-iw)/2:(oh-ih)/2:color=${scene.background},pad=${w}:${h}:${x}:${y}:color=${scene.background}`;
}

export function buildSceneMediaFilter(scene, w, h) {
  const hasSlots = Array.isArray(scene.slots) && scene.slots.length > 0;
  if (scene.assetUrl && !hasSlots) return buildCompositionMediaFilter(scene, w, h);
  if (scene.layout === 'split' && scene.assetUrl) {
    return `scale=${w}:${Math.round(h / 2)}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:0:color=${scene.background}`;
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${scene.background}`;
}

export function buildCompositionAss(scene, w, h) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2) throw new Error('Invalid composition canvas');
  const layout = composition(scene.composition, scene.layout);
  const font = process.platform === 'win32' ? 'Malgun Gothic' : 'Noto Sans CJK KR';
  const dialogues = [
    ['title', scene.title, 'title'],
    ['body', scene.text, 'body'],
  ].filter(([, value]) => String(value || '').length).map(([layer, value, fitLayer]) => {
    const box = layout[layer], fitted = fitText(value, box, w, h, fitLayer);
    const x = Math.round((box.x + box.width / 2) * w), y = Math.round((box.y + box.height / 2) * h);
    const text = escapeAssText(fitted.text);
    return `Dialogue: 0,0:00:00.00,0:10:00.00,Default,,0,0,0,,{\\an5\\pos(${x},${y})\\fs${fitted.fontSize}\\b1\\bord3\\shad2\\q2}${text}`;
  }).join('\n');
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font},48,&H00FFFFFF,&H000000FF,&H00101010,&H90000000,-1,0,0,0,100,100,0,0,1,3,2,5,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${dialogues}${dialogues ? '\n' : ''}`;
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
    .replace(/<[^>]+>/g, '');
}

export function buildSceneCompositionPlan(scene, w, h) {
  const slots = Array.isArray(scene.slots) ? [...scene.slots].sort((a, b) => (Number(a.zIndex) || 0) - (Number(b.zIndex) || 0)) : [];
  const font = process.platform === 'win32' ? 'Malgun Gothic' : 'Noto Sans CJK KR';
  const alignment = scene.layout === 'lower-third' ? 2 : 5;
  const margin = scene.layout === 'lower-third' ? Math.round(h * 0.16) : 80;
  const styles = [
    `Style: Default,${font},${w > h ? 64 : 62},&H00FFFFFF,&H000000FF,&H00101010,&H90000000,-1,0,0,0,100,100,0,0,1,3,2,${alignment},90,90,${margin},1`,
  ];
  const dialogues = [];
  const globalDialogues = [];
  const slotDialogues = new Map();
  if (slots.length && scene.text && !slots.some((slot) => ['subtitle-layer', 'text-overlay'].includes(slot.role) && slot.text)) {
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
    const combinedText = `${badgePrefix}${copySource || ''}`;
    if (combinedText) {
      const charCols = Math.max(8, Math.round((sw / w) * (w > h ? 36 : 18)));
      const slotAlign = slot.style?.align === 'left' ? 4 : slot.style?.align === 'right' ? 6 : 5;
      const textX = slotAlign === 4 ? sx + 12 : slotAlign === 6 ? sx + sw - 12 : cx;
      const textDialogue = `Dialogue: ${Math.max(1, Number(slot.zIndex) || index + 1)},0:00:00.00,0:10:00.00,${styleName},,0,0,0,,{\\an${slotAlign}\\pos(${textX},${cy})}${subtitleText(combinedText, charCols)}`;
      dialogues.push(textDialogue);
      slotDialogues.set(index, textDialogue);
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
  const slotAss = Object.fromEntries([...slotDialogues.entries()].map(([index, dialogue]) => [index, makeAss([dialogue])]));
  return { ass: slots.length ? makeAss(dialogues) : buildCompositionAss(scene, w, h), globalAss: globalDialogues.length ? makeAss(globalDialogues) : '', slotAss, slotBoxes: slotBoxes.map((box) => slotAss[box.index] ? { ...box, textAss: slotAss[box.index] } : box), hasSlots: slots.length > 0 };
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

export async function renderEpisode(episode, { dataDir, onProgress = () => {} }) {
  if (!dimensions[episode.format] || !episode.scenes?.length || episode.scenes.length > 60) throw new Error('Invalid render timeline');
  const [w, h] = dimensions[episode.format];
  const root = path.resolve(dataDir), name = `${randomUUID()}.mp4`;
  const temp = path.join(root, 'render-work', randomUUID());
  await mkdir(temp, { recursive: true });
  await mkdir(path.join(root, 'exports'), { recursive: true });
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    for (let i = 0; i < episode.scenes.length; i++) {
      const scene = episode.scenes[i], duration = Number(scene.duration);
      if (!(duration >= 0.25 && duration <= 120) || !/^#[\da-f]{6}$/i.test(scene.background)) throw new Error('Invalid scene duration/color');
      const plan = buildSceneCompositionPlan(scene, w, h);
      await writeFile(path.join(temp, `scene-${i}.ass`), plan.ass);
      if (plan.globalAss) await writeFile(path.join(temp, `scene-${i}-global.ass`), plan.globalAss);
      for (const [slotIndex, slotAss] of Object.entries(plan.slotAss || {})) await writeFile(path.join(temp, `scene-${i}-slot-${slotIndex}.ass`), slotAss);
      let input = ['-f', 'lavfi', '-i', `color=c=${scene.background}:s=${w}x${h}:r=30:d=${duration}`];
      let mediaAudio = false;
      const trimStart = Number(scene.trimStart || 0), audioVolume = Number(scene.audioVolume ?? 1);
      if (!Number.isFinite(trimStart) || trimStart < 0 || trimStart > 36000 || !Number.isFinite(audioVolume) || audioVolume < 0 || audioVolume > 2) throw new Error('Invalid trim/audio volume');
      if (scene.assetUrl) {
        const { source, mediaOptions } = await resolveVerifiedUpload(root, scene.assetUrl);
        input = scene.kind === 'image' ? [...mediaOptions, '-stream_loop', '-1', '-i', source] : [...mediaOptions, '-ss', String(trimStart), '-i', source];
        if (scene.kind === 'video') {
          const probe = await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', ...mediaOptions, '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', source], { timeout: 15000 });
          mediaAudio = probe.stdout.trim() === 'audio';
        }
      }

      const slotInputs = [];
      for (const box of plan.slotBoxes) {
        if (!box.hasAsset) continue;
        const { source, mediaOptions } = await resolveVerifiedUpload(root, box.slot.assetUrl);
        const isImage = box.slot.mediaKind === 'image' || /\.(?:png|jpe?g|webp|gif)$/i.test(source);
        slotInputs.push({
          ...box,
          isImage,
          args: isImage ? [...mediaOptions, '-stream_loop', '-1', '-i', source] : [...mediaOptions, '-ss', '0', '-i', source],
        });
      }

      const base = buildSceneMediaFilter(scene, w, h);

      let audioInput = ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
      const audioInputIndex = 1 + slotInputs.length;
      let audioMap = mediaAudio ? '0:a:0' : `${audioInputIndex}:a:0`;
      if (scene.audioUrl) {
        const match = /^\/api\/uploads\/([a-zA-Z0-9_-]+\.(?:mp3|wav|ogg))$/.exec(scene.audioUrl);
        if (!match) throw new Error('Invalid audio upload');
        const uploadRoot = await realpath(path.join(root, 'uploads'));
        const source = await realpath(path.join(uploadRoot, match[1]));
        if (path.dirname(source) !== uploadRoot) throw new Error('Audio path escapes uploads');
        audioInput = [...localMediaInputOptions(source), '-i', source];
        audioMap = `${audioInputIndex}:a:0`;
      }

      let filterArgs;
      let videoMap = '0:v:0';
      if (!plan.hasSlots) {
        const filter = `${base},setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=${duration},subtitles=scene-${i}.ass`;
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
        chains.push(`[${currentLabel}]null[vout]`);
        filterArgs = ['-filter_complex', chains.join(';')];
        videoMap = '[vout]';
      }

      const allInputs = [...input, ...slotInputs.flatMap((item) => item.args), ...audioInput];
      const args = ['-hide_banner', '-loglevel', 'error', '-y', ...allInputs, '-map', videoMap, '-map', audioMap, ...filterArgs, '-af', `volume=${audioVolume},apad`, '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-threads', '2', `segment-${i}.mp4`];
      await execute(ffmpeg, args, { cwd: temp, timeout: 300000 });
      onProgress(Math.round((i + 1) / episode.scenes.length * 90));
    }
    await writeFile(path.join(temp, 'concat.txt'), episode.scenes.map((_, i) => `file 'segment-${i}.mp4'`).join('\n'));
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-c', 'copy', '-movflags', '+faststart', 'final.mp4'], { cwd: temp });
    await copyFile(path.join(temp, 'final.mp4'), path.join(root, 'exports', name));
    onProgress(100);
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path.join(root, 'exports', name))) digest.update(chunk);
    return { filename: name, outputUrl: `/api/exports/${name}`, sha256: digest.digest('hex') };
  } finally {
    const actualParent = await realpath(path.join(root, 'render-work'));
    const actualTemp = await realpath(temp);
    if (path.dirname(actualTemp) !== actualParent) throw new Error('Unsafe render cleanup path');
    await rm(actualTemp, { recursive: true, force: true });
  }
}
