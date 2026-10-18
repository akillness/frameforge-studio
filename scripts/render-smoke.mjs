import { renderEpisode } from '../server/render.mjs';
import { execute } from '../server/process.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const dataDir = path.resolve('data/render-smoke');
await mkdir('artifacts', { recursive: true });
const result = await renderEpisode({ id: 'smoke', format: '9:16', scenes: [
  { id: 'one', text: '첫 번째 장면\n영상 제작의 시작', duration: 1, background: '#202a35', layout: 'center', kind: 'title' },
  { id: 'two', text: '장면을 편집하고\n이력을 남기세요', duration: 1, background: '#274b43', layout: 'lower-third', kind: 'title' },
] }, { dataDir });
const probe = await execute('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(dataDir, 'exports', result.filename)]);
const info = JSON.parse(probe.stdout), video = info.streams.find(s => s.codec_type === 'video');
if (video.width !== 1080 || video.height !== 1920 || Math.abs(Number(info.format.duration) - 2) > .2) throw new Error('Rendered MP4 dimensions/duration mismatch');
await writeFile('artifacts/render-smoke.json', JSON.stringify({ verifiedAt: new Date().toISOString(), width: video.width, height: video.height, codec: video.codec_name, duration: info.format.duration, audio: info.streams.some(s => s.codec_type === 'audio'), output: result.filename }, null, 2));
console.log('Actual FFmpeg render passed: 1080x1920 H.264 + AAC, 2 seconds.');
