import { randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'JSON object required');
  return value;
}

export function text(value, name, max = 500, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new HttpError(400, `${name} must be nonempty text (maximum ${max} characters)`);
  }
  return value.trim();
}

export function optionalText(value, name, max = 5000) {
  return value === undefined || value === '' ? '' : text(value, name, max);
}

export function choice(value, values, name, fallback) {
  const selected = value ?? fallback;
  if (!values.includes(selected)) throw new HttpError(400, `Invalid ${name}`);
  return selected;
}

export function url(value) {
  const input = text(value, 'url', 2000);
  let parsed;
  try { parsed = new URL(input); } catch { throw new HttpError(400, 'Invalid URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new HttpError(400, 'Only HTTP(S) URLs without credentials are allowed');
  return parsed.href;
}

export const formats = ['9:16', '16:9', '1:1'];
export const layouts = ['center', 'lower-third', 'split', 'top-image-mid-video', 'premiere-3tier', 'custom'];
export const slotRoles = ['image-gen', 'video-bg', 'text-overlay', 'subtitle-layer', 'html-overlay'];
export const slotDataBindings = ['scene.imagePrompt', 'scene.videoPrompt', 'scene.title', 'scene.text', 'scene.narration', 'trend.keyword', 'news.headline', 'custom'];

function boundedNumber(value, name, min, max, fallback) {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== 'number' || !Number.isFinite(selected) || selected < min || selected > max) throw new HttpError(400, `${name} must be a number between ${min} and ${max}`);
  return selected;
}

function sourceEvidence(value) {
  const visit = (item, depth) => {
    if (depth > 4) throw new HttpError(400, 'Source evidence is too deeply nested');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') return item === '' ? '' : text(item, 'source evidence', 4000);
    if (Array.isArray(item)) {
      if (item.length > 64) throw new HttpError(400, 'Too many source evidence entries');
      return item.map((entry) => visit(entry, depth + 1));
    }
    object(item);
    const entries = Object.entries(item);
    if (entries.length > 64) throw new HttpError(400, 'Too many source evidence fields');
    return Object.fromEntries(entries.map(([key, entry]) => {
      text(key, 'source evidence key', 120);
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new HttpError(400, 'Invalid source evidence key');
      return [key, visit(entry, depth + 1)];
    }));
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 16000) throw new HttpError(400, 'Source evidence exceeds 16000 bytes');
  return result;
}

export function episodeMusic(value) {
  if (value === undefined || value === null) return value;
  const music = object(value);
  if (Object.keys(music).some((key) => !['assetUrl', 'start', 'trimStart', 'volume', 'source'].includes(key))) throw new HttpError(400, 'Invalid music field');
  if (typeof music.assetUrl !== 'string' || !/^\/api\/uploads\/[a-zA-Z0-9_-]+\.(?:mp3|wav|ogg)$/i.test(music.assetUrl)) throw new HttpError(400, 'Invalid music upload');
  for (const [key, max] of [['start', 1800], ['trimStart', 36000], ['volume', 2]]) {
    if (typeof music[key] !== 'number' || !Number.isFinite(music[key]) || music[key] < 0 || music[key] > max) throw new HttpError(400, `Invalid music ${key}`);
  }
  const source = object(music.source);
  if (!['own', 'third-party', 'generated'].includes(source.origin)) throw new HttpError(400, 'Invalid music source origin');
  return { assetUrl: music.assetUrl, start: music.start, trimStart: music.trimStart, volume: music.volume, source: sourceEvidence(source) };
}

/** Optional provenance is editable evidence, not an implicit rights clearance. */
export function sceneSource(value) {
  if (value === undefined) return undefined;
  const source = object(value);
  const allowed = ['origin', 'sourceUrl', 'licenseId', 'attribution', 'retrievedAt', 'sha256', 'useAs', 'generationJobId', 'evidence'];
  if (Object.keys(source).some((key) => !allowed.includes(key))) throw new HttpError(400, 'Unknown media source field');
  const result = {
    origin: choice(source.origin, ['own', 'third-party', 'generated'], 'source origin'),
    useAs: choice(source.useAs, ['evidence', 'illustration'], 'source useAs'),
  };
  if (result.origin === 'generated' && result.useAs !== 'illustration') throw new HttpError(400, 'Generated visuals cannot be factual event evidence');
  if (source.sourceUrl !== undefined) result.sourceUrl = source.sourceUrl === '' ? '' : url(source.sourceUrl);
  for (const [key, max] of [['licenseId', 160], ['attribution', 4000]]) {
    if (source[key] !== undefined) result[key] = optionalText(source[key], `source ${key}`, max);
  }
  if (source.retrievedAt !== undefined) {
    const timestamp = text(source.retrievedAt, 'source retrievedAt', 80);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) throw new HttpError(400, 'Invalid source retrievedAt');
    result.retrievedAt = timestamp;
  }
  if (source.sha256 !== undefined) {
    if (typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sha256)) throw new HttpError(400, 'Invalid source sha256');
    result.sha256 = source.sha256;
  }
  if (source.generationJobId !== undefined) {
    result.generationJobId = text(source.generationJobId, 'source generationJobId', 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(result.generationJobId)) throw new HttpError(400, 'Invalid source generationJobId');
  }
  if (source.evidence !== undefined) result.evidence = sourceEvidence(source.evidence);
  return result;
}

function mediaTrim(value, start = 0) {
  if (value === undefined) return undefined;
  const end = boundedNumber(value, 'trimEnd', 0, 36000);
  if (end <= start) throw new HttpError(400, 'trimEnd must be after trimStart');
  return end;
}

function validateSlotStyle(raw) {
  if (raw === undefined || raw === null) return undefined;
  const style = object(raw);
  const allowed = ['backgroundColor', 'textColor', 'fontSize', 'opacity', 'borderRadius', 'align', 'badge'];
  if (Object.keys(style).some((key) => !allowed.includes(key))) throw new HttpError(400, 'Unknown slot style field');
  const normalized = {};
  if (style.backgroundColor !== undefined && style.backgroundColor !== '') {
    if (typeof style.backgroundColor !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(style.backgroundColor)) throw new HttpError(400, 'Slot backgroundColor must be a six-digit hex color');
    normalized.backgroundColor = style.backgroundColor;
  }
  if (style.textColor !== undefined && style.textColor !== '') {
    if (typeof style.textColor !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(style.textColor)) throw new HttpError(400, 'Slot textColor must be a six-digit hex color');
    normalized.textColor = style.textColor;
  }
  if (style.fontSize !== undefined) normalized.fontSize = boundedNumber(style.fontSize, 'slot fontSize', 10, 140, 36);
  if (style.opacity !== undefined) normalized.opacity = boundedNumber(style.opacity, 'slot opacity', 0, 1, 0.85);
  if (style.borderRadius !== undefined) normalized.borderRadius = boundedNumber(style.borderRadius, 'slot borderRadius', 0, 80, 8);
  if (style.align !== undefined) normalized.align = choice(style.align, ['left', 'center', 'right'], 'slot align', 'center');
  if (style.badge !== undefined && style.badge !== '') normalized.badge = optionalText(style.badge, 'slot badge', 80);
  return Object.keys(normalized).length ? normalized : undefined;
}

export function sceneSlots(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, 'Scene slots must be an array');
  if (value.length > 16) throw new HttpError(400, 'At most 16 layout slots are allowed per scene');
  const ids = new Set();
  return value.map((raw, index) => {
    const slot = object(raw);
    const id = slot.id === undefined ? `slot-${index + 1}` : text(slot.id, 'slot id', 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new HttpError(400, 'Slot IDs must be unique and portable');
    ids.add(id);
    const role = choice(slot.role, slotRoles, 'slot role', 'html-overlay');
    const dataBinding = choice(slot.dataBinding, slotDataBindings, 'slot dataBinding', 'custom');
    const name = text(slot.name, 'slot name', 120, role === 'image-gen' ? '상단 이미지 생성' : role === 'video-bg' ? '중단 배경 영상' : role === 'subtitle-layer' ? '자막 레이어' : role === 'text-overlay' ? '텍스트 레이아웃' : 'HTML 오버레이');
    const x = boundedNumber(slot.x, 'slot x', 0, 100, 0);
    const y = boundedNumber(slot.y, 'slot y', 0, 100, 0);
    const w = boundedNumber(slot.w, 'slot w', 5, 100, 100);
    const h = boundedNumber(slot.h, 'slot h', 5, 100, 30);
    const zIndex = Math.round(boundedNumber(slot.zIndex, 'slot zIndex', 0, 100, index + 1));
    const slotText = optionalText(slot.text, 'slot text', 2000);
    const html = optionalText(slot.html, 'slot html', 4000);
    const prompt = optionalText(slot.prompt, 'slot prompt', 4000);
    const model = optionalText(slot.model, 'slot model', 160);
    const assetUrl = optionalText(slot.assetUrl, 'slot assetUrl', 200);
    if (assetUrl && !/^\/api\/uploads\/[a-f0-9-]{36}\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|ogg)$/i.test(assetUrl)) {
      throw new HttpError(400, 'Slot assets must be local uploaded media');
    }
    const mediaKind = choice(slot.mediaKind, ['none', 'image', 'video'], 'slot mediaKind', assetUrl ? (/\.(?:mp4|webm|mov)$/i.test(assetUrl) ? 'video' : 'image') : 'none');
    const style = validateSlotStyle(slot.style);
    const source = sceneSource(slot.source);
    const trimStart = slot.trimStart === undefined ? undefined : boundedNumber(slot.trimStart, 'slot trimStart', 0, 36000);
    const trimEnd = mediaTrim(slot.trimEnd, trimStart ?? 0);
    return {
      id,
      name,
      role,
      dataBinding,
      x,
      y,
      w,
      h,
      zIndex,
      ...(slotText ? { text: slotText } : {}),
      ...(html ? { html } : {}),
      ...(prompt ? { prompt } : {}),
      ...(model ? { model } : {}),
      ...(assetUrl ? { assetUrl, mediaKind } : mediaKind !== 'none' ? { mediaKind } : {}),
      ...(style ? { style } : {}),
      ...(source ? { source } : {}),
      ...(slot.evidence !== undefined ? { evidence: sourceEvidence(slot.evidence) } : {}),
      ...(trimStart !== undefined ? { trimStart } : {}),
      ...(trimEnd !== undefined ? { trimEnd } : {}),
    };
  });
}

export function createPresetSlots(preset, scene = {}) {
  const title = scene.title || '핵심 장면';
  const bodyText = scene.text || '자막 및 핵심 메시지';
  const narration = scene.narration || bodyText;
  if (preset === 'premiere-3tier') {
    return [
      {
        id: 'slot-top-banner',
        name: '상단 HTML 뉴스 배너 오버레이',
        role: 'html-overlay',
        dataBinding: 'news.headline',
        x: 4, y: 3, w: 92, h: 12, zIndex: 8,
        text: title,
        html: `<div class="pencil-card"><span class="pencil-badge">BREAKING</span><strong>${title}</strong></div>`,
        style: { backgroundColor: '#173ea8', textColor: '#ffffff', fontSize: 34, opacity: 0.92, borderRadius: 10, align: 'left', badge: 'NEWS' },
      },
      {
        id: 'slot-top-image',
        name: '상단 AI 이미지 & 텍스트 슬롯',
        role: 'image-gen',
        dataBinding: 'scene.imagePrompt',
        x: 4, y: 17, w: 92, h: 31, zIndex: 2,
        text: title,
        prompt: `${title} · 고해상도 인포그래픽 및 상황 일러스트`,
        style: { backgroundColor: '#242c35', textColor: '#ffffff', fontSize: 32, opacity: 0.85, borderRadius: 8, align: 'center' },
      },
      {
        id: 'slot-mid-video',
        name: '중단 Higgsfield 배경 영상 레이어',
        role: 'video-bg',
        dataBinding: 'scene.videoPrompt',
        x: 0, y: 50, w: 100, h: 50, zIndex: 1,
        prompt: `${bodyText} · 시네마틱 카메라 워크 배경 영상`,
        ...(scene.assetUrl && scene.kind === 'video' ? { assetUrl: scene.assetUrl, mediaKind: 'video' } : {}),
        style: { backgroundColor: '#121820', textColor: '#ffffff', fontSize: 28, opacity: 1, align: 'center' },
      },
      {
        id: 'slot-mid-subtitle',
        name: '중단/하단 자막 오버레이 레이어',
        role: 'subtitle-layer',
        dataBinding: 'scene.narration',
        x: 6, y: 76, w: 88, h: 16, zIndex: 10,
        text: narration,
        style: { backgroundColor: '#0f1419', textColor: '#ffffff', fontSize: 42, opacity: 0.82, borderRadius: 8, align: 'center', badge: 'SUBTITLE' },
      },
    ];
  }
  // Default: 'top-image-mid-video' (상단 이미지생성+텍스트, 중단 배경영상+자막, Pencil HTML 오버레이)
  return [
    {
      id: 'slot-top-image',
      name: '상단 이미지 생성 모듈',
      role: 'image-gen',
      dataBinding: 'scene.imagePrompt',
      x: 4, y: 4, w: 92, h: 34, zIndex: 2,
      text: title,
      prompt: `${title} · 핵심 시각 자료 이미지 생성`,
      ...(scene.assetUrl && scene.kind === 'image' ? { assetUrl: scene.assetUrl, mediaKind: 'image' } : {}),
      style: { backgroundColor: '#1e293b', textColor: '#ffffff', fontSize: 34, opacity: 0.9, borderRadius: 8, align: 'center' },
    },
    {
      id: 'slot-top-text',
      name: '상단 텍스트 레이아웃 오버레이',
      role: 'text-overlay',
      dataBinding: 'scene.title',
      x: 8, y: 7, w: 84, h: 12, zIndex: 6,
      text: title,
      style: { backgroundColor: '#2851c8', textColor: '#ffffff', fontSize: 38, opacity: 0.88, borderRadius: 6, align: 'center', badge: 'HEADLINE' },
    },
    {
      id: 'slot-mid-video',
      name: '중단 배경 영상 레이어 (Higgsfield)',
      role: 'video-bg',
      dataBinding: 'scene.videoPrompt',
      x: 0, y: 40, w: 100, h: 60, zIndex: 1,
      prompt: `${bodyText} · 역동적인 배경 영상 연출`,
      ...(scene.assetUrl && scene.kind === 'video' ? { assetUrl: scene.assetUrl, mediaKind: 'video' } : {}),
      style: { backgroundColor: '#0f172a', textColor: '#ffffff', fontSize: 30, opacity: 1, align: 'center' },
    },
    {
      id: 'slot-mid-subtitle',
      name: '중단 영상 위 자막 레이어',
      role: 'subtitle-layer',
      dataBinding: 'scene.text',
      x: 6, y: 74, w: 88, h: 18, zIndex: 10,
      text: bodyText,
      html: `<div class="pencil-subtitle">${bodyText}</div>`,
      style: { backgroundColor: '#111827', textColor: '#ffffff', fontSize: 44, opacity: 0.84, borderRadius: 8, align: 'center', badge: 'CC' },
    },
  ];
}

export function sceneCaptions(value, duration) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 200) throw new HttpError(400, 'Captions must be an array of at most 200 cues');
  return value.map((cue) => {
    if (!cue || typeof cue !== 'object' || Array.isArray(cue) ||
        typeof cue.start !== 'number' || !Number.isFinite(cue.start) ||
        typeof cue.end !== 'number' || !Number.isFinite(cue.end) ||
        !Number.isFinite(duration) || cue.start < 0 || cue.start >= cue.end || cue.end > duration ||
        Math.round(cue.start * 100) >= Math.round(cue.end * 100)) {
      throw new HttpError(400, 'Invalid caption timing');
    }
    text(cue.text, 'caption text', 2000);
    return { start: cue.start, end: cue.end, text: cue.text };
  });
}

export function scenes(value) {
  if (!Array.isArray(value) || !value.length || value.length > 60) throw new HttpError(400, 'Between 1 and 60 scenes are required');
  const ids = new Set();
  const result = value.map((raw) => {
    const scene = object(raw);
    const id = scene.id === undefined ? randomUUID() : text(scene.id, 'scene id', 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new HttpError(400, 'Scene IDs must be unique and portable');
    ids.add(id);
    if (typeof scene.duration !== 'number' || !Number.isFinite(scene.duration) || scene.duration < 0.5 || scene.duration > 120) throw new HttpError(400, 'Scene duration must be 0.5–120 seconds');
    if (typeof scene.background !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(scene.background)) throw new HttpError(400, 'Background must be a six-digit hex color');
    const assetUrl = optionalText(scene.assetUrl, 'assetUrl', 200);
    if (assetUrl && !/^\/api\/uploads\/[a-f0-9-]{36}\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|ogg)$/i.test(assetUrl)) throw new HttpError(400, 'Scene assets must be local uploaded media');
    const audioUrl = optionalText(scene.audioUrl, 'audioUrl', 200);
    if (audioUrl && !/^\/api\/uploads\/[a-f0-9-]{36}\.(?:mp3|wav|ogg)$/i.test(audioUrl)) throw new HttpError(400, 'Scene audio must be a local uploaded audio file');
    const trimStart = boundedNumber(scene.trimStart, 'trimStart', 0, 36000, 0);
    const trimEnd = mediaTrim(scene.trimEnd, trimStart);
    const source = sceneSource(scene.source);
    const audioSource = sceneSource(scene.audioSource);
    const audioVolume = boundedNumber(scene.audioVolume, 'audioVolume', 0, 2, 1);
    const kind = choice(scene.kind, ['title', 'video', 'image'], 'scene kind', 'title');
    if (kind !== 'title' && !assetUrl) throw new HttpError(400, `${kind} scenes require an uploaded asset`);
    const layout = choice(scene.layout, layouts, 'layout', 'center');
    const validatedSlots = sceneSlots(scene.slots);
    const captions = sceneCaptions(scene.captions, scene.duration);
    return {
      id,
      title: text(scene.title, 'scene title', 160, '장면'),
      text: optionalText(scene.text, 'scene text', 2000),
      duration: scene.duration,
      ...(captions !== undefined ? { captions } : {}),
      background: scene.background,
      kind,
      layout,
      ...(assetUrl ? { assetUrl } : {}),
      ...(audioUrl ? { audioUrl } : {}),
      trimStart,
      ...(trimEnd !== undefined ? { trimEnd } : {}),
      ...(source ? { source } : {}),
      ...(audioSource ? { audioSource } : {}),
      ...(scene.evidence !== undefined ? { evidence: sourceEvidence(scene.evidence) } : {}),
      audioVolume,
      narration: optionalText(scene.narration, 'narration', 4000),
      ...(Array.isArray(validatedSlots) && validatedSlots.length ? { slots: validatedSlots } : {}),
    };
  });
  if (result.reduce((sum, scene) => sum + scene.duration, 0) > 1800) throw new HttpError(400, 'Episode duration must not exceed 30 minutes');
  return result;
}

export function episodePatch(body) {
  object(body);
  if ('archivedAt' in body) throw new HttpError(400, 'Use the versioned archive or unarchive action');
  const patch = {};
  for (const [key, max] of [['title', 200], ['topic', 500]]) if (key in body) patch[key] = text(body[key], key, max);
  if ('notes' in body) patch.notes = optionalText(body.notes, 'notes', 20000);
  if ('status' in body) patch.status = choice(body.status, ['draft', 'review', 'ready'], 'status');
  if ('format' in body) patch.format = choice(body.format, formats, 'format');
  if ('scenes' in body) patch.scenes = scenes(body.scenes);
  if ('music' in body) patch.music = episodeMusic(body.music);
  if ('expectedVersion' in body && (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1)) throw new HttpError(400, 'expectedVersion must be a positive integer');
  if (!Object.keys(patch).length) throw new HttpError(400, 'No editable fields supplied');
  return patch;
}
