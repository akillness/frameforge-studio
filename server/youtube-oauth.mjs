// Channel-bound YouTube OAuth (Authorization Code + PKCE) per
// artifacts/production-workspace-implementation/protocols.json "VerifiedYouTubeProtocol" and
// plan.json "publication" (owner: DeliveryImplementation). Tokens, authorization codes, PKCE
// verifiers and one-time OAuth state never reach entities/events/history/exports — they live
// only in encrypted, 0600 runtime files under <dataDir>/.private/. Every public method
// returns a sanitized shape except accessToken(), the internal publication transport API.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { PrivateRuntime } from './private-runtime.mjs';
import { HttpError, text } from './validation.mjs';

export const YOUTUBE_OAUTH_COOKIE_NAME = 'frameforge_youtube_oauth';
export const YOUTUBE_OAUTH_CALLBACK_PATH = '/oauth/youtube/callback';
export const YOUTUBE_OAUTH_COOKIE_PATH = '/oauth/youtube';
export const YOUTUBE_OAUTH_STATE_TTL_SECONDS = 600;
// protocols.json VerifiedYouTubeProtocol.scope: the one documented write-capable scope that
// suffices for this insert/read/update integration.
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CHANNELS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/channels';
const STATE_TTL_MS = YOUTUBE_OAUTH_STATE_TTL_SECONDS * 1000; // Matches Main's correlation-cookie Max-Age=600.
const TESTING_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // protocols.json oauth.testing: 7-day bound; YouTube scopes do not qualify for the identity-only exception.
const ACCESS_TOKEN_SKEW_MS = 60 * 1000; // [INFERENCE] refresh slightly ahead of literal expiry to avoid races with in-flight calls.
const MAX_BODY_BYTES = 1024 * 1024;
// [INFERENCE] Public YouTube channel ID shape (24 chars: "UC" + 22 URL-safe characters).
// protocols.json documents the "UC..." convention by example, not as a formal regex.
const CHANNEL_EXTERNAL_ID = /^UC[\w-]{22}$/;
const SAFE_FILENAME = /^[a-zA-Z0-9-]{1,80}$/;

function validateToken(result) {
  if (!result || typeof result.access_token !== 'string' || !result.access_token || /[\r\n]/.test(result.access_token) || !Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0 || Date.now() + Number(result.expires_in) * 1000 > 8.64e15 || (result.token_type && String(result.token_type).toLowerCase() !== 'bearer') || (result.refresh_token !== undefined && (typeof result.refresh_token !== 'string' || !result.refresh_token || /[\r\n]/.test(result.refresh_token)))) {
    throw new HttpError(502, 'Google returned an invalid token response');
  }
  return result;
}

function refreshExpiry(tokens, testing) {
  const expiries = [];
  if (Number.isFinite(tokens.refreshExpiresAt)) expiries.push(tokens.refreshExpiresAt);
  if ((testing || tokens.testingMode) && tokens.refreshIssuedAt) expiries.push(tokens.refreshIssuedAt + TESTING_REFRESH_TTL_MS);
  return expiries.length ? Math.min(...expiries) : null;
}

function sha256(value) { return createHash('sha256').update(value).digest(); }
function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return timingSafeEqual(sha256(left), sha256(right));
}
function base64url(buffer) { return buffer.toString('base64url'); }

async function readBoundedJson(response, errorMessage) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(502, errorMessage);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(502, errorMessage); }
}

/** Channel-bound OAuth with one-time state+PKCE, encrypted private-file token storage and a
 * sanitized public surface. See plan.json "publication.oauth"/"oauthRules" for the frozen
 * contract this class implements. */
export class YouTubeOAuth {
  constructor({ store, fetchImpl = fetch, clientId, clientSecret, redirectUri, testing = false, tokenKey } = {}) {
    if (!store) throw new Error('YouTubeOAuth requires a store');
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.clientId = clientId || '';
    this.clientSecret = clientSecret || '';
    this.redirectUri = redirectUri || '';
    this.testing = testing === true;
    this.privateRuntime = new PrivateRuntime({ dataDir: store.dataDir, tokenKey });
    this.refreshes = new Map();
  }

  _assertConfigured() {
    if (!this.clientId || !this.clientSecret || !this.redirectUri) throw new HttpError(503, 'YouTube OAuth client is not configured');
    let redirect;
    try { redirect = new URL(this.redirectUri); } catch { throw new HttpError(503, 'YouTube OAuth redirect URI is not configured correctly'); }
    if (redirect.username || redirect.password || redirect.hash || !['https:', 'http:'].includes(redirect.protocol) || (redirect.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname))) throw new HttpError(503, 'YouTube OAuth redirect URI is not configured correctly');
  }

  _stateName(state) { return `youtube-state-${sha256(state).toString('hex')}`; }
  _tokenName(channelId) {
    if (!SAFE_FILENAME.test(channelId)) throw new HttpError(400, 'Invalid channel identifier');
    return `youtube-token-${channelId}`;
  }
  async _writeState(state, record) { this.privateRuntime.write(this._stateName(state), record); }
  async _claimState(state) { return this.privateRuntime.consume(this._stateName(state)); }
  async _readTokens(channelId) { return this.privateRuntime.read(this._tokenName(channelId)); }
  async _writeTokens(channelId, tokens) { this.privateRuntime.write(this._tokenName(channelId), tokens); }
  async _deleteTokens(channelId) { this.privateRuntime.remove(this._tokenName(channelId)); }

  /** channelId must already carry a known UC… externalId (set via Store.setChannelExternalId
   * before this is ever called) — never guessed/set here or at callback. */
  async begin(channelId, { sessionId, correlationToken } = {}) {
    const id = text(channelId, 'channelId', 80);
    const session = text(sessionId, 'sessionId', 200);
    const correlation = text(correlationToken, 'correlationToken', 200);
    this._assertConfigured();
    const channel = this.store.get('channels', id);
    if (!CHANNEL_EXTERNAL_ID.test(channel.externalId || '')) throw new HttpError(400, 'Channel must have a known YouTube channel ID (UC…) bound before authorize. Set it first.');
    const state = base64url(randomBytes(32));
    const codeVerifier = base64url(randomBytes(64)); // 86 chars, within RFC 7636's 43-128 range.
    const codeChallenge = base64url(sha256(codeVerifier));
    await this._writeState(state, {
      channelId: id,
      channelExternalId: channel.externalId,
      sessionId: session,
      correlationToken: correlation,
      codeVerifier,
      clientId: this.clientId,
      redirectUri: this.redirectUri,
      expiresAt: Date.now() + STATE_TTL_MS,
    });
    const authUrl = new URL(AUTH_ENDPOINT);
    authUrl.searchParams.set('client_id', this.clientId);
    authUrl.searchParams.set('redirect_uri', this.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', YOUTUBE_SCOPE);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    return { authUrl: authUrl.href };
  }

  /** Never throws for a legitimate-but-failed OAuth outcome (denied/invalid/expired/mismatch/
   * insufficient-scope) — those return a sanitized {status,channelId,connected:false,message}.
   * Throws only for structurally-impossible calls or genuine upstream (Google) infra failure. */
  async complete({ state, code, error, correlationToken } = {}, { isSessionActive } = {}) {
    if (typeof isSessionActive !== 'function') throw new HttpError(500, 'YouTubeOAuth.complete requires isSessionActive');
    const stateValue = typeof state === 'string' ? state.slice(0, 2000) : '';
    const errorValue = typeof error === 'string' ? error.slice(0, 200) : '';
    const codeValue = typeof code === 'string' ? code.slice(0, 4000) : '';
    const correlationValue = typeof correlationToken === 'string' ? correlationToken.slice(0, 500) : '';
    if (!stateValue && !errorValue) throw new HttpError(400, 'OAuth callback requires state or error');
    const fail = (status, channelId, message) => ({ status, channelId: channelId || null, connected: false, message });
    if (!stateValue) return fail('invalid_state', null, 'Google reported an error with no state to correlate it to');
    const record = await this._claimState(stateValue);
    if (!record) return fail('invalid_state', null, 'OAuth state is unknown, already used, or expired');
    if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) return fail('session_expired', record.channelId, 'OAuth attempt expired; reconnect the channel');
    if (!safeEqual(correlationValue, record.correlationToken)) return fail('invalid_state', record.channelId, 'OAuth correlation cookie did not match the initiating request');
    let active;
    try { active = await isSessionActive(record.sessionId); } catch { active = false; }
    if (active !== true) return fail('session_expired', record.channelId, 'The session that started this authorization is no longer active');
    if (errorValue) return fail('denied', record.channelId, 'Google declined authorization');
    if (!codeValue) throw new HttpError(400, 'OAuth callback is missing both code and error');
    this._assertConfigured();
    if (record.redirectUri !== this.redirectUri || record.clientId !== this.clientId) return fail('invalid_state', record.channelId, 'YouTube OAuth configuration changed; restart authorization');
    const intended = this.store.get('channels', record.channelId);
    if (intended.externalId !== record.channelExternalId || !CHANNEL_EXTERNAL_ID.test(intended.externalId || '')) return fail('channel_mismatch', record.channelId, 'The configured YouTube channel changed; restart authorization');
    let tokenResponse;
    try { tokenResponse = await this._exchangeCode(codeValue, record.codeVerifier); }
    catch (err) { if (err instanceof HttpError) throw err; throw new HttpError(502, 'Could not reach the Google token endpoint'); }
    validateToken(tokenResponse);
    const grantedScope = typeof tokenResponse.scope === 'string' ? tokenResponse.scope : '';
    let channels;
    try { channels = await this._listMineChannels(tokenResponse.access_token); }
    catch (err) { if (err instanceof HttpError) throw err; throw new HttpError(502, 'Could not reach the YouTube channels endpoint'); }
    // Exact match only — never the first item, never onBehalfOfContentOwnerChannel.
    const matched = channels.some((item) => item?.id === record.channelExternalId);
    if (!matched) return fail('channel_mismatch', record.channelId, 'The authorized Google account does not own the configured YouTube channel');
    if (!grantedScope.split(/\s+/).includes(YOUTUBE_SCOPE)) return fail('insufficient_scope', record.channelId, 'YouTube did not grant the required youtube.force-ssl scope');
    try { active = await isSessionActive(record.sessionId); } catch { active = false; }
    if (active !== true) return fail('session_expired', record.channelId, 'The initiating session expired during authorization');
    if (this.store.get('channels', record.channelId).externalId !== record.channelExternalId) return fail('channel_mismatch', record.channelId, 'The configured YouTube channel changed during authorization');
    const stored = await this._readTokens(record.channelId);
    const previous = stored?.channelExternalId === record.channelExternalId && stored?.clientId === this.clientId && !stored.revoked ? stored : null;
    const now = Date.now();
    const refreshToken = tokenResponse.refresh_token || previous?.refreshToken || null;
    const newRefresh = Boolean(tokenResponse.refresh_token) && tokenResponse.refresh_token !== previous?.refreshToken;
    const tokens = {
      accessToken: tokenResponse.access_token,
      refreshToken,
      scope: grantedScope,
      tokenType: tokenResponse.token_type || 'Bearer',
      expiresAt: now + Number(tokenResponse.expires_in) * 1000,
      connectedAt: now,
      connectionId: base64url(randomBytes(24)),
      channelExternalId: record.channelExternalId,
      clientId: this.clientId,
      refreshIssuedAt: newRefresh ? now : previous?.refreshIssuedAt || null,
      refreshExpiresAt: Number.isFinite(Number(tokenResponse.refresh_token_expires_in)) && Number(tokenResponse.refresh_token_expires_in) >= 0 ? now + Number(tokenResponse.refresh_token_expires_in) * 1000 : newRefresh ? null : previous?.refreshExpiresAt || null,
      testingMode: newRefresh ? this.testing : previous?.testingMode ?? this.testing,
      revoked: false,
    };
    await this._writeTokens(record.channelId, tokens);
    this.store.record('channels.youtube.connected', { entityId: record.channelId });
    return this._statusFor(record.channelId, tokens);
  }

  async status(channelId) {
    const id = text(channelId, 'channelId', 80);
    this.store.get('channels', id);
    return this._statusFor(id, this.clientId && this.clientSecret && this.redirectUri ? await this._readTokens(id) : null);
  }

  _statusFor(channelId, tokens) {
    const channel = this.store.get('channels', channelId);
    const configured = Boolean(this.clientId && this.clientSecret && this.redirectUri);
    const base = {
      channelId, channelExternalId: channel.externalId || '', channelTitle: channel.name || null,
      channelUpdatedAt: channel.updatedAt, configured, lastCheckedAt: new Date().toISOString(),
      status: configured ? 'not_connected' : 'not_configured', connected: false,
      scope: null, hasForceSslScope: false, expiresAt: null, hasRefreshToken: false,
      testingMode: this.testing, refreshTokenExpiresAt: null, reconsentRequired: false, lastConnectedAt: null,
    };
    if (!configured || !tokens) return base;
    const scope = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : [];
    const hasForceSslScope = scope.includes(YOUTUBE_SCOPE);
    const hasRefreshToken = typeof tokens.refreshToken === 'string' && Boolean(tokens.refreshToken);
    const refreshTokenExpiresAt = refreshExpiry(tokens, this.testing);
    const refreshExpired = refreshTokenExpiresAt !== null && refreshTokenExpiresAt <= Date.now();
    const accessExpired = !Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= Date.now();
    const mismatch = !CHANNEL_EXTERNAL_ID.test(channel.externalId || '') || channel.externalId !== tokens.channelExternalId || tokens.clientId !== this.clientId;
    const reconsentRequired = Boolean(tokens.revoked || mismatch || !hasForceSslScope || refreshExpired || (accessExpired && !hasRefreshToken));
    const status = tokens.revoked ? 'revoked' : mismatch ? 'channel_mismatch' : !hasForceSslScope ? 'insufficient_scope' : refreshExpired ? 'reconsent_required' : accessExpired && !hasRefreshToken ? 'expired' : 'connected';
    return {
      ...base, status, connected: !reconsentRequired, scope, hasForceSslScope,
      expiresAt: Number.isFinite(tokens.expiresAt) ? new Date(tokens.expiresAt).toISOString() : null,
      hasRefreshToken, testingMode: Boolean(this.testing || tokens.testingMode),
      refreshTokenExpiresAt: refreshTokenExpiresAt !== null ? new Date(refreshTokenExpiresAt).toISOString() : null,
      reconsentRequired, lastConnectedAt: Number.isFinite(tokens.connectedAt) ? new Date(tokens.connectedAt).toISOString() : null,
    };
  }

  /** Refreshes are serialized per channel, with no account fallback or retry after revocation. */
  async accessToken(channelId) {
    const id = text(channelId, 'channelId', 80);
    this._assertConfigured();
    this.store.get('channels', id);
    const pending = this.refreshes.get(id);
    if (pending) return pending;
    const operation = this._accessToken(id);
    this.refreshes.set(id, operation);
    try { return await operation; }
    finally { if (this.refreshes.get(id) === operation) this.refreshes.delete(id); }
  }

  async _accessToken(id) {
    const tokens = await this._readTokens(id);
    if (!tokens || !this._statusFor(id, tokens).connected) throw new HttpError(409, 'YouTube authorization is unavailable or expired; reauthorize this channel');
    if (tokens.expiresAt > Date.now() + ACCESS_TOKEN_SKEW_MS) return tokens.accessToken;
    if (!tokens.refreshToken) {
      if (tokens.expiresAt > Date.now()) return tokens.accessToken;
      throw new HttpError(409, 'YouTube connection has no refresh token; reauthorize the channel');
    }
    let refreshed;
    try { refreshed = await this._refreshTokens(tokens.refreshToken); }
    catch (error) {
      if (error?.code === 'invalid_grant') {
        const current = await this._readTokens(id);
        if (current?.connectionId === tokens.connectionId) await this._writeTokens(id, { ...tokens, revoked: true });
        throw new HttpError(409, 'YouTube authorization was revoked or expired; reauthorize the channel');
      }
      throw error instanceof HttpError ? error : new HttpError(502, 'Could not refresh the YouTube access token');
    }
    validateToken(refreshed);
    const current = await this._readTokens(id);
    if (!current || current.connectionId !== tokens.connectionId || !this._statusFor(id, current).connected) throw new HttpError(409, 'YouTube connection changed during refresh');
    const scope = typeof refreshed.scope === 'string' ? refreshed.scope : tokens.scope;
    if (!scope.split(/\s+/).includes(YOUTUBE_SCOPE)) {
      await this._writeTokens(id, { ...tokens, scope, revoked: true });
      throw new HttpError(409, 'Required YouTube permission was removed; reauthorize the channel');
    }
    const now = Date.now();
    const next = {
      ...tokens, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || tokens.refreshToken,
      expiresAt: now + Number(refreshed.expires_in) * 1000, scope,
      // Refresh rotation does not extend the original consent's Testing deadline.
      refreshExpiresAt: refreshed.refresh_token_expires_in !== undefined && Number.isFinite(Number(refreshed.refresh_token_expires_in)) && Number(refreshed.refresh_token_expires_in) >= 0
        ? now + Number(refreshed.refresh_token_expires_in) * 1000 : tokens.refreshExpiresAt,
    };
    await this._writeTokens(id, next);
    return next.accessToken;
  }

  /** Local-only: deletes the stored tokens. No documented Google revoke call is part of this
   * contract's verified protocol surface. */
  async disconnect(channelId) {
    const id = text(channelId, 'channelId', 80);
    this.store.get('channels', id);
    await this._deleteTokens(id);
    this.store.record('channels.youtube.disconnected', { entityId: id });
    return this._statusFor(id, null);
  }

  async _exchangeCode(code, codeVerifier) {
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, code, redirect_uri: this.redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier });
    const response = await this.fetchImpl(TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), redirect: 'error', signal: AbortSignal.timeout(15000) });
    const result = await readBoundedJson(response, 'Invalid response from the Google token endpoint');
    if (!response.ok) { const err = new HttpError(502, 'Google token exchange was rejected'); err.code = result.error === 'invalid_grant' ? 'invalid_grant' : 'token_error'; throw err; }
    return result;
  }

  async _refreshTokens(refreshToken) {
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken });
    const response = await this.fetchImpl(TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), redirect: 'error', signal: AbortSignal.timeout(15000) });
    const result = await readBoundedJson(response, 'Invalid response from the Google token endpoint');
    if (!response.ok) { const err = new HttpError(502, 'Google token refresh was rejected'); err.code = result.error === 'invalid_grant' ? 'invalid_grant' : 'token_error'; throw err; }
    return result;
  }

  async _listMineChannels(accessToken) {
    const url = new URL(CHANNELS_ENDPOINT);
    url.searchParams.set('part', 'id,snippet');
    url.searchParams.set('mine', 'true');
    const response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const result = await readBoundedJson(response, 'Invalid response from the YouTube channels endpoint');
    if (!response.ok) throw new HttpError(502, `YouTube channels lookup failed (HTTP ${response.status})`);
    return Array.isArray(result.items) ? result.items : [];
  }
}
