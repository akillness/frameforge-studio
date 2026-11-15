import { HttpError, object, text, optionalText } from './validation.mjs';

const DEFAULT_API_BASE = 'https://discord.com/api/v10';
const DISCORD_USER_AGENT = 'FrameForgeStudio (https://github.com/akillness/frameforge-studio, 1.0)';
const SNOWFLAKE = /^\d{17,22}$/;
const WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
const MAX_RESPONSE_BYTES = 262144;
const DEFAULT_EVENTS = Object.freeze({ workflow: true, review: true, render: true, publication: true });

function cleanError(error, fallback = 'Discord request failed') {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  if (!message) return fallback;
  return message.replace(/Bot\s+[A-Za-z0-9._-]+/gi, 'Bot [redacted]').replace(/https:\/\/[^\s]+/gi, '[url]').slice(0, 300);
}

export function validateDiscordWebhookUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let parsed;
  try { parsed = new URL(raw.trim()); } catch { throw new HttpError(400, 'Invalid DISCORD_WEBHOOK_URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !WEBHOOK_HOSTS.has(parsed.hostname) || !/^\/api\/webhooks\/\d{17,22}\/[A-Za-z0-9_-]+$/.test(parsed.pathname) || parsed.search || parsed.hash) {
    throw new HttpError(400, 'DISCORD_WEBHOOK_URL must be an official Discord HTTPS webhook URL');
  }
  return parsed.toString();
}

export function validateChannelId(value, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, 'Discord channelId must be a 17-22 digit snowflake ID');
    return '';
  }
  const trimmed = String(value).trim();
  if (!SNOWFLAKE.test(trimmed)) throw new HttpError(400, 'Discord channelId must be a 17-22 digit snowflake ID');
  return trimmed;
}

export function normalizeAllowedUserIds(value) {
  if (value === undefined || value === null || value === '') return [];
  const rawList = Array.isArray(value) ? value : String(value).split(',');
  const result = [];
  for (const item of rawList) {
    const trimmed = String(item).trim();
    if (!trimmed) continue;
    if (!SNOWFLAKE.test(trimmed)) throw new HttpError(400, 'Discord allowedUserIds must contain 17-22 digit user IDs');
    if (!result.includes(trimmed)) result.push(trimmed);
    if (result.length > 50) throw new HttpError(400, 'Discord allowedUserIds supports at most 50 entries');
  }
  return result;
}

export function normalizeCommandPrefix(value, fallback = '!ff') {
  if (value === undefined || value === null || value === '') return fallback;
  const cleaned = text(value, 'commandPrefix', 32).replace(/[\r\n\t]/g, '').trim();
  if (!cleaned) throw new HttpError(400, 'Discord commandPrefix cannot be empty');
  return cleaned;
}

export function normalizeNotifyEvents(value, base = DEFAULT_EVENTS) {
  if (value === undefined) return { ...base };
  object(value);
  const next = { ...base };
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(DEFAULT_EVENTS, key)) throw new HttpError(400, `Unsupported Discord notification event: ${key}`);
    if (typeof value[key] !== 'boolean') throw new HttpError(400, `Discord notifyEvents.${key} must be boolean`);
    next[key] = value[key];
  }
  return next;
}

export function discordEnvDefaults(env = process.env) {
  const botToken = typeof env.DISCORD_BOT_TOKEN === 'string' ? env.DISCORD_BOT_TOKEN.trim() : '';
  let webhookUrl = '';
  let webhookInvalid = false;
  if (typeof env.DISCORD_WEBHOOK_URL === 'string' && env.DISCORD_WEBHOOK_URL.trim()) {
    try { webhookUrl = validateDiscordWebhookUrl(env.DISCORD_WEBHOOK_URL); } catch { webhookInvalid = true; }
  }
  let channelId = '';
  try { channelId = validateChannelId(env.DISCORD_CHANNEL_ID, false); } catch { channelId = ''; }
  let allowedUserIds = [];
  try { allowedUserIds = normalizeAllowedUserIds(env.DISCORD_ALLOWED_USER_IDS); } catch { allowedUserIds = []; }
  let commandPrefix = '!ff';
  try { commandPrefix = normalizeCommandPrefix(env.DISCORD_COMMAND_PREFIX, '!ff'); } catch { commandPrefix = '!ff'; }
  const explicitEnabled = env.DISCORD_NOTIFY_ENABLED === 'true' ? true : env.DISCORD_NOTIFY_ENABLED === 'false' ? false : undefined;
  return {
    botToken,
    webhookUrl,
    webhookInvalid,
    channelId,
    allowedUserIds,
    commandPrefix,
    enabled: explicitEnabled ?? Boolean(channelId && (botToken || webhookUrl)),
  };
}

export function extractDiscordCommand(content, prefix = '!ff') {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (!trimmed || !prefix) return null;
  if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const rest = trimmed.slice(prefix.length);
  if (!rest || !/^[\s:]/.test(rest)) return null;
  const body = rest.replace(/^[:\s]+/, '').trim();
  return body ? body.slice(0, 20000) : null;
}

async function boundedJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new HttpError(502, 'Discord response exceeds size limit');
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { message: raw.slice(0, 200) }; }
}

export function formatDiscordNotification(eventType, payload = {}) {
  const line = (label, value) => value ? `${label}: ${String(value).replace(/[\r\n]+/g, ' ').slice(0, 200)}` : '';
  const parts = [];
  if (eventType === 'test') {
    parts.push('[FrameForge Studio] Discord 연동 테스트 알림');
    if (payload.message) parts.push(String(payload.message).slice(0, 1200));
  } else if (eventType === 'workflow') {
    const statusLabels = { awaiting_review: '검토 대기', completed: '완료', failed: '실패', cancelled: '취소' };
    parts.push(`[FrameForge 워크플로] ${statusLabels[payload.status] || payload.status || '상태 변경'}`);
    parts.push(line('에피소드', payload.episodeTitle || payload.episodeId));
    parts.push(line('워크플로', payload.workflowName || payload.workflowId));
    parts.push(line('실행 ID', payload.runId));
    if (payload.error) parts.push(line('오류', payload.error));
  } else if (eventType === 'review') {
    parts.push(`[FrameForge 검토] ${payload.decision === 'approved' ? '승인됨' : '수정 요청'}`);
    parts.push(line('에피소드', payload.episodeTitle || payload.episodeId));
    parts.push(line('노드', payload.reviewNodeId));
    parts.push(line('메모', payload.notes));
  } else if (eventType === 'render') {
    parts.push(`[FrameForge 렌더] ${payload.status === 'completed' ? '완료' : '실패'}`);
    parts.push(line('에피소드', payload.episodeTitle || payload.episodeId));
    parts.push(line('버전', payload.episodeVersion ? `v${payload.episodeVersion}` : ''));
    parts.push(line('출력', payload.outputUrl));
    if (payload.error) parts.push(line('오류', payload.error));
  } else if (eventType === 'publication') {
    parts.push(`[FrameForge 공개] ${payload.status || '상태 변경'}`);
    parts.push(line('채널', payload.channelId));
    parts.push(line('에피소드', payload.episodeId));
    parts.push(line('영상 ID', payload.videoId));
    if (payload.error) parts.push(line('오류', payload.error));
  } else {
    parts.push(`[FrameForge 알림] ${eventType}`);
    if (payload.message) parts.push(String(payload.message).slice(0, 1200));
  }
  return parts.filter(Boolean).join('\n').slice(0, 1900);
}

export function buildDiscordIntegrationStatus(settings = {}, env = process.env) {
  const defaults = discordEnvDefaults(env);
  const hasBotToken = Boolean(defaults.botToken);
  const hasWebhook = Boolean(defaults.webhookUrl);
  const channelId = settings.channelId ?? defaults.channelId;
  const enabled = settings.enabled ?? defaults.enabled;
  const transport = hasBotToken && channelId ? 'rest' : hasWebhook ? 'webhook' : hasBotToken ? 'rest' : 'none';
  const configured = Boolean((hasBotToken && channelId) || hasWebhook);
  const verified = Boolean(configured && settings.lastVerifiedAt && !settings.lastError);

  let status = 'unavailable';
  let detail = 'DISCORD_BOT_TOKEN + 채널 ID 또는 DISCORD_WEBHOOK_URL 설정 필요';
  if (defaults.webhookInvalid && !hasBotToken) {
    status = 'unavailable';
    detail = 'DISCORD_WEBHOOK_URL 형식이 올바르지 않습니다';
  } else if (verified) {
    status = 'available';
    const botLabel = settings.botUser?.username ? `${settings.botUser.username}` : 'Webhook';
    const channelLabel = settings.channelName ? `#${settings.channelName}` : channelId ? `채널 ${channelId}` : 'Webhook 채널';
    detail = `${transport === 'rest' ? 'REST' : 'Webhook'} 연결됨 (${botLabel} · ${channelLabel}${enabled ? ' · 알림 켜짐' : ' · 알림 꺼짐'})`;
  } else if (configured) {
    status = 'configured';
    detail = `${transport === 'rest' ? `REST 채널 ${channelId}` : 'Webhook'} 설정됨 · 연결 확인 필요`;
  } else if (hasBotToken) {
    status = 'configured';
    detail = '봇 토큰 설정됨 · 대상 Discord 채널 ID 설정 필요';
  }

  return {
    available: verified,
    configured,
    status,
    transport,
    enabled: Boolean(enabled),
    hasBotToken,
    hasWebhook,
    channelId: channelId || '',
    channelName: settings.channelName || '',
    commandPrefix: settings.commandPrefix || defaults.commandPrefix,
    allowedUserIds: Array.isArray(settings.allowedUserIds) ? settings.allowedUserIds : defaults.allowedUserIds,
    notifyEvents: { ...DEFAULT_EVENTS, ...(settings.notifyEvents || {}) },
    botUser: settings.botUser || null,
    lastVerifiedAt: settings.lastVerifiedAt || null,
    lastSyncedMessageId: settings.lastSyncedMessageId || null,
    lastNotifiedAt: settings.lastNotifiedAt || null,
    lastError: settings.lastError || null,
    detail,
  };
}

export class DiscordService {
  constructor({ store, env = process.env, fetchImpl = fetch, apiBase = DEFAULT_API_BASE } = {}) {
    this.store = store;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase.replace(/\/$/, '');
  }

  defaults() {
    return discordEnvDefaults(this.env);
  }

  settings() {
    const defaults = this.defaults();
    const stored = this.store.getDiscordSettings();
    return {
      enabled: stored.enabled ?? defaults.enabled,
      channelId: stored.channelId ?? defaults.channelId,
      channelName: stored.channelName || '',
      commandPrefix: stored.commandPrefix || defaults.commandPrefix,
      allowedUserIds: stored.allowedUserIds ?? defaults.allowedUserIds,
      notifyEvents: { ...DEFAULT_EVENTS, ...(stored.notifyEvents || {}) },
      botUser: stored.botUser || null,
      lastVerifiedAt: stored.lastVerifiedAt || null,
      lastSyncedMessageId: stored.lastSyncedMessageId || null,
      lastNotifiedAt: stored.lastNotifiedAt || null,
      lastError: stored.lastError || null,
    };
  }

  status() {
    return buildDiscordIntegrationStatus(this.settings(), this.env);
  }

  updateSettings(body) {
    object(body);
    const allowed = ['enabled', 'channelId', 'commandPrefix', 'allowedUserIds', 'notifyEvents'];
    for (const key of Object.keys(body)) {
      if (!allowed.includes(key)) throw new HttpError(400, `Unsupported Discord setting: ${key}`);
    }
    const current = this.settings();
    const patch = {};
    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'Discord enabled must be boolean');
      patch.enabled = body.enabled;
    }
    if ('channelId' in body) {
      const nextChannelId = validateChannelId(body.channelId, false);
      patch.channelId = nextChannelId;
      if (nextChannelId !== current.channelId) {
        patch.channelName = '';
        patch.lastSyncedMessageId = null;
        patch.lastVerifiedAt = null;
        patch.lastError = null;
      }
    }
    if ('commandPrefix' in body) patch.commandPrefix = normalizeCommandPrefix(body.commandPrefix);
    if ('allowedUserIds' in body) patch.allowedUserIds = normalizeAllowedUserIds(body.allowedUserIds);
    if ('notifyEvents' in body) patch.notifyEvents = normalizeNotifyEvents(body.notifyEvents, current.notifyEvents);
    this.store.saveDiscordSettings(patch);
    return this.status();
  }

  async _botRequest(route, { method = 'GET', body } = {}) {
    const { botToken } = this.defaults();
    if (!botToken) throw new HttpError(400, 'DISCORD_BOT_TOKEN is not configured');
    let response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${route}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bot ${botToken}`,
          'user-agent': DISCORD_USER_AGENT,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new HttpError(502, `Discord API request failed: ${cleanError(error)}`);
    }
    const data = await boundedJson(response);
    if (!response.ok) {
      const detail = typeof data?.message === 'string' ? data.message : `HTTP ${response.status}`;
      throw new HttpError(response.status === 401 || response.status === 403 ? 502 : response.status >= 400 && response.status < 500 ? response.status : 502, `Discord API error (${response.status}): ${detail}`);
    }
    return data;
  }

  async _webhookRequest({ method = 'GET', body } = {}) {
    const { webhookUrl } = this.defaults();
    if (!webhookUrl) throw new HttpError(400, 'DISCORD_WEBHOOK_URL is not configured');
    const target = method === 'POST' ? `${webhookUrl}?wait=true` : webhookUrl;
    let response;
    try {
      response = await this.fetchImpl(target, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: body ? { 'content-type': 'application/json', 'user-agent': DISCORD_USER_AGENT } : { 'user-agent': DISCORD_USER_AGENT },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new HttpError(502, `Discord webhook request failed: ${cleanError(error)}`);
    }
    const data = await boundedJson(response);
    if (!response.ok) {
      const detail = typeof data?.message === 'string' ? data.message : `HTTP ${response.status}`;
      throw new HttpError(502, `Discord webhook error (${response.status}): ${detail}`);
    }
    return data;
  }

  async verify() {
    const defaults = this.defaults();
    const current = this.settings();
    try {
      if (defaults.botToken) {
        const me = await this._botRequest('/users/@me');
        const botUser = { id: String(me.id || ''), username: String(me.username || '') };
        let channelName = '';
        if (current.channelId) {
          const channel = await this._botRequest(`/channels/${current.channelId}`);
          channelName = typeof channel?.name === 'string' ? channel.name : '';
        } else if (!defaults.webhookUrl) {
          throw new HttpError(400, 'Discord channelId is required for Bot REST verification');
        }
        this.store.saveDiscordSettings({
          botUser,
          channelName,
          lastVerifiedAt: new Date().toISOString(),
          lastError: null,
        });
        this.store.record('discord.verified', { transport: 'rest', channelId: current.channelId || null, botId: botUser.id });
        return this.status();
      }
      if (defaults.webhookUrl) {
        const hook = await this._webhookRequest({ method: 'GET' });
        this.store.saveDiscordSettings({
          botUser: { id: String(hook.id || ''), username: String(hook.name || 'Webhook') },
          ...(hook.channel_id && !current.channelId ? { channelId: String(hook.channel_id) } : {}),
          lastVerifiedAt: new Date().toISOString(),
          lastError: null,
        });
        this.store.record('discord.verified', { transport: 'webhook', channelId: hook.channel_id || current.channelId || null });
        return this.status();
      }
      throw new HttpError(400, 'DISCORD_BOT_TOKEN or DISCORD_WEBHOOK_URL is required');
    } catch (error) {
      this.store.saveDiscordSettings({ lastError: cleanError(error) });
      throw error;
    }
  }

  async _sendMessage(content) {
    const defaults = this.defaults();
    const current = this.settings();
    const payload = { content: String(content).slice(0, 1900), allowed_mentions: { parse: [] } };
    if (defaults.botToken && current.channelId) {
      const sent = await this._botRequest(`/channels/${current.channelId}/messages`, { method: 'POST', body: payload });
      return { transport: 'rest', channelId: current.channelId, messageId: String(sent.id || ''), content: payload.content };
    }
    if (defaults.webhookUrl) {
      const sent = await this._webhookRequest({ method: 'POST', body: payload });
      return { transport: 'webhook', channelId: String(sent.channel_id || current.channelId || ''), messageId: String(sent.id || ''), content: payload.content };
    }
    throw new HttpError(400, 'Discord notification target is not configured');
  }

  async sendTestNotification(body = {}) {
    object(body);
    if (Object.keys(body).some((key) => key !== 'message')) throw new HttpError(400, 'Test notification accepts only message');
    const message = optionalText(body.message, 'message', 1000) || `테스트 시각: ${new Date().toISOString()}`;
    const content = formatDiscordNotification('test', { message });
    try {
      const sent = await this._sendMessage(content);
      const sentAt = new Date().toISOString();
      this.store.saveDiscordSettings({ lastNotifiedAt: sentAt, lastError: null });
      this.store.record('discord.notified', { eventType: 'test', transport: sent.transport, channelId: sent.channelId, messageId: sent.messageId });
      return { ok: true, ...sent, sentAt };
    } catch (error) {
      const messageText = cleanError(error);
      this.store.saveDiscordSettings({ lastError: messageText });
      this.store.record('discord.notify_failed', { eventType: 'test', error: messageText });
      throw error;
    }
  }

  async notify(eventType, payload = {}) {
    const current = this.settings();
    const defaults = this.defaults();
    if (!current.enabled) return { sent: false, reason: 'disabled' };
    if (Object.hasOwn(DEFAULT_EVENTS, eventType) && current.notifyEvents?.[eventType] === false) return { sent: false, reason: 'event_disabled' };
    if (!((defaults.botToken && current.channelId) || defaults.webhookUrl)) return { sent: false, reason: 'unconfigured' };
    const content = formatDiscordNotification(eventType, payload);
    try {
      const sent = await this._sendMessage(content);
      const sentAt = new Date().toISOString();
      this.store.saveDiscordSettings({ lastNotifiedAt: sentAt, lastError: null });
      this.store.record('discord.notified', { eventType, transport: sent.transport, channelId: sent.channelId, messageId: sent.messageId });
      return { sent: true, ...sent, sentAt };
    } catch (error) {
      const messageText = cleanError(error);
      this.store.saveDiscordSettings({ lastError: messageText });
      this.store.record('discord.notify_failed', { eventType, error: messageText });
      return { sent: false, reason: 'failed', error: messageText };
    }
  }

  async syncCommands(body = {}) {
    object(body);
    if (Object.keys(body).some((key) => key !== 'limit')) throw new HttpError(400, 'Discord sync accepts only limit');
    const limit = body.limit === undefined ? 25 : Number(body.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'Discord sync limit must be between 1 and 100');
    const current = this.settings();
    if (!current.channelId) throw new HttpError(400, 'Discord channelId is required to sync commands');
    const query = current.lastSyncedMessageId && SNOWFLAKE.test(current.lastSyncedMessageId)
      ? `/channels/${current.channelId}/messages?limit=${limit}&after=${current.lastSyncedMessageId}`
      : `/channels/${current.channelId}/messages?limit=${limit}`;
    const raw = await this._botRequest(query);
    const messages = (Array.isArray(raw) ? raw : []).filter((msg) => msg && typeof msg.id === 'string' && SNOWFLAKE.test(msg.id));
    messages.sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0));

    let maxId = current.lastSyncedMessageId;
    const imported = [];
    let skipped = 0;
    const allowedUsers = new Set(current.allowedUserIds || []);

    for (const msg of messages) {
      if (!maxId || BigInt(msg.id) > BigInt(maxId)) maxId = msg.id;
      if (msg.author?.bot || msg.webhook_id) { skipped++; continue; }
      const authorId = String(msg.author?.id || '');
      if (allowedUsers.size && !allowedUsers.has(authorId)) { skipped++; continue; }
      const extracted = extractDiscordCommand(msg.content, current.commandPrefix);
      if (!extracted) { skipped++; continue; }
      const authorName = String(msg.member?.nick || msg.author?.global_name || msg.author?.username || authorId).slice(0, 100);
      const { created, command } = this.store.createDiscordCommand({
        message: extracted,
        sessionId: current.channelId,
        externalMessageId: msg.id,
        authorId,
        authorName,
        receivedAt: typeof msg.timestamp === 'string' && Number.isFinite(Date.parse(msg.timestamp)) ? msg.timestamp : new Date().toISOString(),
      });
      if (created) imported.push(command);
      else skipped++;
    }

    if (maxId && maxId !== current.lastSyncedMessageId) {
      this.store.saveDiscordSettings({ lastSyncedMessageId: maxId, lastError: null });
    }
    this.store.record('discord.synced', { channelId: current.channelId, fetched: messages.length, imported: imported.length, skipped });
    return { fetched: messages.length, imported: imported.length, skipped, lastSyncedMessageId: maxId || null, commands: imported };
  }
}
