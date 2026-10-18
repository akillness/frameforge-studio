import { mkdir, writeFile, realpath, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { execute } from './process.mjs';

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

function subtitleText(text, width) {
  const cleaned = String(text || '').replace(/[{}\\]/g, '').replace(/\r/g, '');
  return cleaned.split('\n').flatMap(line => {
    const chars = Array.from(line), rows = [];
    while (chars.length) rows.push(chars.splice(0, width).join(''));
    return rows.length ? rows : [''];
  }).join('\\N');
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
      const alignment = scene.layout === 'lower-third' ? 2 : 5;
      const margin = scene.layout === 'lower-third' ? Math.round(h * .16) : 80;
      const font = process.platform === 'win32' ? 'Malgun Gothic' : 'Noto Sans CJK KR';
      const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font},${w > h ? 64 : 62},&H00FFFFFF,&H000000FF,&H00101010,&H90000000,-1,0,0,0,100,100,0,0,1,3,2,${alignment},90,90,${margin},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:10:00.00,Default,,0,0,0,,${subtitleText(scene.text, w > h ? 34 : 17)}\n`;
      await writeFile(path.join(temp, `scene-${i}.ass`), ass);
      let input = ['-f', 'lavfi', '-i', `color=c=${scene.background}:s=${w}x${h}:r=30:d=${duration}`];
      let mediaAudio = false;
      const trimStart = Number(scene.trimStart || 0), audioVolume = Number(scene.audioVolume ?? 1);
      if (!Number.isFinite(trimStart) || trimStart < 0 || trimStart > 36000 || !Number.isFinite(audioVolume) || audioVolume < 0 || audioVolume > 2) throw new Error('Invalid trim/audio volume');
      if (scene.assetUrl) {
        const match = /^\/api\/uploads\/([a-zA-Z0-9_.-]+)$/.exec(scene.assetUrl);
        if (!match || match[1].includes('..')) throw new Error('Only uploaded local media can be rendered');
        const uploadRoot = await realpath(path.join(root, 'uploads'));
        const source = await realpath(path.join(uploadRoot, match[1]));
        if (path.dirname(source) !== uploadRoot) throw new Error('Media path escapes uploads');
        const mediaOptions = localMediaInputOptions(source);
        input = scene.kind === 'image' ? [...mediaOptions, '-stream_loop', '-1', '-i', source] : [...mediaOptions, '-ss', String(trimStart), '-i', source];
        if (scene.kind === 'video') {
          const probe = await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', ...mediaOptions, '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', source], { timeout: 15000 });
          mediaAudio = probe.stdout.trim() === 'audio';
        }
      }
      const base = scene.layout === 'split' && scene.assetUrl
        ? `scale=${w}:${Math.round(h / 2)}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:0:color=${scene.background}`
        : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${scene.background}`;
      const filter = `${base},setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=${duration},subtitles=scene-${i}.ass`;
      let audioInput = ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
      let audioMap = mediaAudio ? '0:a:0' : '1:a:0';
      if (scene.audioUrl) {
        const match = /^\/api\/uploads\/([a-zA-Z0-9_-]+\.(?:mp3|wav|ogg))$/.exec(scene.audioUrl);
        if (!match) throw new Error('Invalid audio upload');
        const uploadRoot = await realpath(path.join(root, 'uploads'));
        const source = await realpath(path.join(uploadRoot, match[1]));
        if (path.dirname(source) !== uploadRoot) throw new Error('Audio path escapes uploads');
        audioInput = [...localMediaInputOptions(source), '-i', source]; audioMap = '1:a:0';
      }
      const args = ['-hide_banner', '-loglevel', 'error', '-y', ...input, ...audioInput, '-map', '0:v:0', '-map', audioMap, '-vf', filter, '-af', `volume=${audioVolume},apad`, '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-threads', '2', `segment-${i}.mp4`];
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
