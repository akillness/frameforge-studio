
export const DEFAULT_TREND_COLLECTOR_SETTINGS = Object.freeze({
  enabled: false,
  intervalMs: 24 * 60 * 60 * 1000,
  retentionMs: 14 * 24 * 60 * 60 * 1000,
  maxConcurrency: 2,
  nextDueAt: null,
});

const MAX_BACKOFF_MULTIPLIER = 16;
const MAX_TIMER_DELAY = 2_147_483_647;
const stamp = (clock) => {
  const value = typeof clock === 'function' ? clock() : new Date().toISOString();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
};
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class TrendCollector {
  constructor({ store, fetchTrends = async () => ({ trends: [], sources: [] }), intervalMs, concurrency, now = () => new Date().toISOString() } = {}) {
    if (!store) throw new TypeError('TrendCollector requires a store');
    this.store = store;
    this.fetchTrends = fetchTrends;
    this.intervalMs = Number.isFinite(Number(intervalMs)) ? Math.max(60 * 1000, Math.floor(Number(intervalMs))) : undefined;
    this.concurrency = Number.isFinite(Number(concurrency)) ? Math.max(1, Math.min(8, Math.floor(Number(concurrency)))) : undefined;
    this.now = now;
    this.timer = null;
    this.running = false;
    this.stopped = false;
    this.closed = false;
    this.activePromise = null;
    this.activeRunId = null;
    this.inFlight = 0;
    this.cachedSettings = { ...DEFAULT_TREND_COLLECTOR_SETTINGS };
  }

  settings() {
    if (this.closed) return this.cachedSettings;
    const stored = this.store.getTrendCollectorSettings();
    this.cachedSettings = {
      ...DEFAULT_TREND_COLLECTOR_SETTINGS,
      ...stored,
      ...(this.intervalMs ? { intervalMs: this.intervalMs } : {}),
      ...(this.concurrency ? { maxConcurrency: this.concurrency } : {}),
    };
    return this.cachedSettings;
  }

  status() {
    if (this.closed) return { settings: this.cachedSettings, running: false, activeRunId: this.activeRunId, inFlight: this.inFlight, nextDueAt: this.cachedSettings.nextDueAt || null, lastRun: null, lastError: null };
    const settings = this.settings();
    const lastRun = this.store.listTrendCollectionRuns({ limit: 1 })[0] || null;
    return { settings, running: this.running, activeRunId: this.activeRunId, inFlight: this.inFlight, nextDueAt: settings.nextDueAt || lastRun?.nextDueAt || null, lastRun, lastError: lastRun?.status === 'failed' ? lastRun.error : null };
  }

  start() {
    if (this.closed) throw new Error('Trend collector is closed');
    this.stopped = false;
    this.running = true;
    this.schedule();
    return this.status();
  }

  stop() {
    this.running = false;
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    return this.closed ? this.status() : this.status();
  }

  close() {
    if (this.closed) return this.status();
    this.cachedSettings = this.settings();
    if (this.activeRunId) {
      const active = this.store.get('trendCollectionRuns', this.activeRunId);
      if (active?.status === 'running') {
        const interruptedAt = stamp(this.now);
        const retryAt = new Date(Date.parse(interruptedAt) + this.cachedSettings.intervalMs).toISOString();
        this.store.save('trendCollectionRuns', { ...active, status: 'failed', completedAt: interruptedAt, nextDueAt: retryAt, error: 'Trend collection interrupted during shutdown' });
        this.store.saveTrendCollectorSettings({ nextDueAt: retryAt });
      }
    }
    this.stop();
    this.closed = true;
    return this.status();
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.running || this.closed) return;
    const settings = this.settings();
    if (!settings.enabled || this.activePromise) return;
    const current = Date.parse(stamp(this.now));
    const due = settings.nextDueAt ? Date.parse(settings.nextDueAt) : current;
    const delay = Number.isFinite(due) ? Math.min(MAX_TIMER_DELAY, Math.max(0, due - current)) : 0;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runNow().catch(() => {}).finally(() => this.schedule());
    }, delay);
    this.timer.unref?.();
  }

  async runNow({ force = false } = {}) {
    if (this.closed) throw new Error('Trend collector is closed');
    if (this.activePromise) return this.activePromise;
    if (this.stopped && !force) throw new Error('Trend collector is stopped');
    const settings = this.settings();
    const current = stamp(this.now);
    if (!force && !settings.enabled) throw new Error('Trend collector is disabled');
    if (!force && settings.nextDueAt && Date.parse(settings.nextDueAt) > Date.parse(current)) throw new Error(`Trend collection is not due until ${settings.nextDueAt}`);
    return this.collectOnce({ settings });
  }

  async collectOnce({ settings = this.settings() } = {}) {
    if (this.closed) throw new Error('Trend collector is closed');
    if (this.activePromise) return this.activePromise;
    const operation = this._collect({ settings });
    this.activePromise = operation.finally(() => {
      this.activePromise = null;
      this.activeRunId = null;
      this.inFlight = 0;
      if (this.running && !this.closed) this.schedule();
    });
    return this.activePromise;
  }

  async _collect({ settings }) {
    const startedAt = stamp(this.now);
    const run = this.store.create('trendCollectionRuns', { status: 'running', startedAt, completedAt: null, nextDueAt: null, inserted: 0, pruned: 0, cleanupFailures: 0, error: null, sources: [] });
    this.activeRunId = run.id;
    this.inFlight = 1;
    let sourceDiagnostics = [];
    try {
      const result = await this.fetchTrends();
      if (this.closed) throw new Error('Trend collector is closed');
      if (!result || !Array.isArray(result.trends)) throw new Error('Trend source returned an invalid result');
      sourceDiagnostics = Array.isArray(result.sources) ? result.sources : [];
      const usable = result.trends.filter((item) => typeof item?.keyword === 'string' && item.keyword.trim());
      if (!usable.length) {
        const sourceError = sourceDiagnostics.find((source) => source?.status === 'error')?.error;
        throw new Error(sourceError || 'Trend source returned no verified keywords');
      }
      const captured = this.store.collectTrendSnapshot({ ...result, trends: usable }, { now: startedAt, runId: run.id });
      const pruned = this.store.pruneTrendRetention({ now: startedAt });
      const completedAt = stamp(this.now);
      const nextDueAt = new Date(Date.parse(completedAt) + settings.intervalMs).toISOString();
      this.store.saveTrendCollectorSettings({ nextDueAt });
      const summary = { ...run, status: 'completed', completedAt, nextDueAt, inserted: captured.trends.length, pruned: pruned.removed + pruned.removedMedia, cleanupFailures: pruned.cleanupFailures || 0, sources: captured.sources };
      this.store.save('trendCollectionRuns', summary);
      return { trends: captured.trends, sources: captured.sources, runId: run.id, status: summary.status, startedAt, completedAt, inserted: summary.inserted, pruned: summary.pruned, cleanupFailures: summary.cleanupFailures };
    } catch (error) {
      if (this.closed) throw error;
      const previousRuns = this.store.listTrendCollectionRuns({ limit: 200 }).filter((item) => item.id !== run.id);
      let consecutiveFailures = 0;
      for (const previous of previousRuns) {
        if (previous.status === 'failed') consecutiveFailures += 1;
        else break;
      }
      const multiplier = Math.min(MAX_BACKOFF_MULTIPLIER, 2 ** Math.min(4, consecutiveFailures));
      const failedAt = stamp(this.now);
      const retryAt = new Date(Date.parse(failedAt) + settings.intervalMs * multiplier).toISOString();
      const failed = { ...run, status: 'failed', completedAt: failedAt, nextDueAt: retryAt, error: error instanceof Error ? error.message : String(error), sources: sourceDiagnostics };
      this.store.save('trendCollectionRuns', failed);
      this.store.saveTrendCollectorSettings({ nextDueAt: retryAt });
      throw error;
    }
  }
}

export { wait as trendCollectorWait };
