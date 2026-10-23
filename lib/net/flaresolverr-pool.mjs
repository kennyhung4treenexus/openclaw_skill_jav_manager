/**
 * FlareSolverr pool — simple round-robin, session-reuse, per-worker session rotation.
 *
 * v3 (Plan B v2):
 *   - Stripped: rate limiter, global CF detection, dedicated ports
 *   - Added: per-worker JAV-owned session rotation
 *   - Strategy: rotate session every ~40 items (per maker) → fresh __cf_bm cookie
 *   - Each worker sticks to one port (avoids FlareSolverr concurrent-session bug)
 */

import { assertJavFlaresolverrPorts, log, sleep } from '../shared.mjs';

const HEALTH_TIMEOUT_MS = 5000;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 min

export class FlareSolverrPool {
  constructor(options = {}) {
    this.ports = assertJavFlaresolverrPorts(options.ports || [8291, 8292, 8293]);
    this.healthTimeoutMs = options.healthTimeoutMs || HEALTH_TIMEOUT_MS;
    this.cooldownMs = options.cooldownMs || COOLDOWN_MS;
    this.maxTimeout = options.maxTimeout || 60000;
    this.warmupTimeout = options.warmupTimeout || 120000;
    this.maxAttempts = options.maxAttempts || 2;
    this.maxFailStreak = options.maxFailStreak || 3;
    this.requestDelayMs = options.requestDelayMs || 200;
    this.sessionPrefix = options.session || 'jav-pool';
    this.warmupUrl = options.warmupUrl || null;

    // Session rotation. This never restarts a container.
    this.restartBetweenMakers = options.restartBetweenMakers !== false;

    // Worker → port mapping
    this._workerMap = new Map();   // workerId → port
    this._workerSessions = new Map(); // workerId → JAV-owned session
    this._ownedSessions = new Map(); // session → port

    // Per-port mutex — prevents FlareSolverr concurrent-session bug (#1685)
    // Only one request at a time per port
    this._portLocks = new Map();   // port → Promise (resolves when port is free)

    // Standard pool state
    this.healthyPorts = [...this.ports];
    this.unhealthyUntil = new Map();
    this._nextIndex = 0;
    this._initialized = false;

    this._warmedUp = new Set();
    this._sessionCookies = new Map();
    this._failStreak = new Map();
    this._lastRequestMs = new Map();
  }

  async initialize() {
    const checks = await Promise.all(
      this.ports.map(async (port) => ({
        port,
        ok: await this._checkHealth(port),
      }))
    );

    this.healthyPorts = checks.filter((c) => c.ok).map((c) => c.port);

    if (this.healthyPorts.length === 0) {
      throw new Error(
        `No healthy FlareSolverr instances on ports: ${this.ports.join(', ')}`
      );
    }

    const unhealthy = checks.filter((c) => !c.ok).map((c) => c.port);
    if (unhealthy.length > 0) {
      log(`[pool] Preflight skipped unhealthy: ${unhealthy.join(', ')}`, 'warn');
    }

    log(`[pool] Ready: ${this.healthyPorts.join(', ')} warmup=${this.warmupTimeout}ms`, 'info');

    if (this.warmupUrl) {
      await this._preWarm();
    }

    this._initialized = true;
  }

  /**
   * Assign a port to a worker. Worker always uses this port (sticky).
   * Returns { port, session } for use by the worker's scraper.
   */
  assignWorker(workerId) {
    const idx = (workerId - 1) % this.ports.length;
    const port = this.ports[idx];
    const session = `${this.sessionPrefix}-w${workerId}`;
    this._workerMap.set(workerId, port);
    this._workerSessions.set(workerId, session);
    log(`[pool] Worker ${workerId} → :${port} (session: ${session})`, 'info');
    return { port, session };
  }

  _workerIdForPort(port) {
    for (const [workerId, mappedPort] of this._workerMap.entries()) {
      if (mappedPort === port) return workerId;
    }
    return null;
  }

  _isPoisonSessionError(message) {
    const lowered = String(message || '').toLowerCase();
    return lowered.includes('tab crashed') || lowered.includes('invalid cookie domain');
  }

  /**
   * Rotate session for a worker.
   * - New session name → fresh Chrome profile → fresh __cf_bm cookie
   * - Optionally destroys the previous JAV-owned session
   * - Pre-warms the new session
   */
  async rotateWorkerSession(workerId, options = {}) {
    const port = this._workerMap.get(workerId);
    if (!port) {
      log(`[pool] rotateWorkerSession: worker ${workerId} not assigned`, 'warn');
      return null;
    }

    const ts = Date.now();
    const newSession = `${this.sessionPrefix}-w${workerId}-${ts}`;

    // Clear warm state for this port
    this._warmedUp.delete(port);
    this._sessionCookies.delete(port);
    this._failStreak.set(port, 0);

    // Destroy only the previous JAV-owned session. Container lifecycle is
    // managed separately and is never part of maker/session rotation.
    if (this.restartBetweenMakers) {
      await this._destroySession(port, this._workerSessions.get(workerId));
    }
    this._workerSessions.set(workerId, newSession);

    // ── Pre-warm new session ──
    // Poison retries skip warmup so a crashed tab cannot hold the port
    // for warmupTimeout (default 120s) while other workers wait.
    if (this.warmupUrl && options.skipWarmup !== true) {
      await this._warmPort(port, newSession);
    }

    log(`[pool] Worker ${workerId} session rotated → ${newSession}`, 'info');
    return { port, session: newSession };
  }

  // ── Core requestGet ───────────────────────────────────

  /**
   * Fetch a URL via FlareSolverr.
   * Simple round-robin with failover. No rate limiting, no global CF.
   *
   * @param {string} url
   * @param {{
   *   maxTimeout?: number,
   *   session?: string,
   *   cookies?: Array<{name:string, value:string, domain?:string}>,
   *   preferredPort?: number,
   * }} [options]
   */
  async requestGet(url, options = {}) {
    if (!this._initialized) {
      throw new Error('FlareSolverrPool not initialized');
    }

    const triedPorts = new Set();
    const maxAttempts = Math.min(this.maxAttempts, this.ports.length);
    let lastError;
    let poisonRetried = false;
    let requestOptions = { ...options };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let port;

      if (
        requestOptions.preferredPort &&
        !triedPorts.has(requestOptions.preferredPort) &&
        !this._isCoolingDown(requestOptions.preferredPort)
      ) {
        port = requestOptions.preferredPort;
      }

      if (!port) {
        port = this._nextPort(triedPorts);
      }

      if (!port) break;
      triedPorts.add(port);

      // Per-port mutex — prevents FlareSolverr concurrent-session bug
      // Wait for any in-flight request on this port to finish
      await this._acquirePortLock(port);

      let poisonRotate = null;
      try {
        log(`[pool] :${port} → ${url.substring(0, 70)}`, 'debug');
        return await this._tryRequest(port, url, requestOptions, attempt);
      } catch (error) {
        lastError = error;
        this._handleRequestFailure(port, error.message);

        if (this._isPoisonSessionError(error.message) && !poisonRetried) {
          poisonRotate = { port, workerId: this._workerIdForPort(port) };
        } else if (attempt < maxAttempts) {
          log(`[pool] :${port} failed (${attempt}/${maxAttempts}): ${error.message}`, 'warn');
        }
      } finally {
        this._releasePortLock(port);
      }

      if (poisonRotate && !poisonRetried) {
        poisonRetried = true;
        if (poisonRotate.workerId) {
          const rotated = await this.rotateWorkerSession(poisonRotate.workerId, {
            skipWarmup: true,
          });
          if (rotated?.session) {
            requestOptions = {
              ...requestOptions,
              session: rotated.session,
              forceFreshSession: false,
              preferredPort: poisonRotate.port,
            };
          }
        } else {
          requestOptions = { ...requestOptions, forceFreshSession: true };
        }
        triedPorts.delete(poisonRotate.port);
        log(`[pool] :${poisonRotate.port} poisoned session; rotating and retrying`, 'warn');
      }
    }

    throw lastError || new Error('No healthy FlareSolverr instance available');
  }

  // ── Private ────────────────────────────────────────────

  async _tryRequest(port, url, options = {}, attempt = 1) {
    // Per-port throttle
    const lastReq = this._lastRequestMs.get(port) || 0;
    const waitMs = lastReq + this.requestDelayMs - Date.now();
    if (waitMs > 0) {
      await sleep(Math.min(waitMs, 1000));
    }

    const isWarm = this._warmedUp.has(port);
    const timeout = isWarm ? (options.maxTimeout || this.maxTimeout) : this.warmupTimeout;

    const baseSession = options.session || `${this.sessionPrefix}-${port}`;
    const session = options.forceFreshSession ? `${baseSession}-r${attempt}` : baseSession;
    this._ownedSessions.set(session, port);
    const body = { cmd: 'request.get', url, maxTimeout: timeout, session };

    // Merge session cookies with request-level cookies
    const sessionCookies = this._sessionCookies.get(port) || [];
    const extraCookies = options.cookies || [];
    const mergedCookies = [...sessionCookies];
    for (const ec of extraCookies) {
      if (!mergedCookies.find(c => c.name === ec.name)) {
        mergedCookies.push(ec);
      }
    }
    if (mergedCookies.length > 0) {
      body.cookies = mergedCookies;
    }

    this._lastRequestMs.set(port, Date.now());

    const resp = await fetch(`http://localhost:${port}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout + 15000),
    });

    if (!resp.ok) {
      throw new Error(`FlareSolverr HTTP ${resp.status} on :${port}`);
    }

    const data = await resp.json();

    if (data.status !== 'ok') {
      throw new Error(`FlareSolverr error on :${port}: ${data.message || 'unknown'}`);
    }

    // Success — mark warm, store cookies, reset fail streak
    this._warmedUp.add(port);
    if (data.solution?.cookies?.length) {
      this._sessionCookies.set(port, data.solution.cookies);
    }
    this._failStreak.set(port, 0);

    return {
      html: data.solution.response,
      cookies: data.solution.cookies || [],
      port,
      session,
    };
  }

  _handleRequestFailure(port, errorMessage) {
    const streak = (this._failStreak.get(port) || 0) + 1;
    this._failStreak.set(port, streak);

    if (streak >= this.maxFailStreak) {
      this._warmedUp.delete(port);
      this._sessionCookies.delete(port);
      this._markUnhealthy(port, errorMessage);
    }
  }

  async _checkHealth(port) {
    try {
      const resp = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  getHealthyPorts() {
    return this.healthyPorts;
  }

  _isCoolingDown(port) {
    return (this.unhealthyUntil.get(port) ?? 0) > Date.now();
  }

  _markUnhealthy(port, reason) {
    const until = Date.now() + this.cooldownMs;
    this.unhealthyUntil.set(port, until);
    log(`[pool] :${port} cooling down ${Math.round(this.cooldownMs / 1000)}s (${reason})`, 'warn');
  }

  // Per-port mutex — prevents FlareSolverr concurrent-session bug (#1685)
  async _acquirePortLock(port) {
    // Wait for any existing lock on this port to release
    while (this._portLocks.has(port)) {
      await this._portLocks.get(port);
    }
    // Create our lock
    let release;
    this._portLocks.set(port, new Promise(resolve => { release = resolve; }));
    // Store release function for _releasePortLock
    this._portLocks.set(port + '-release', release);
  }

  _releasePortLock(port) {
    const release = this._portLocks.get(port + '-release');
    this._portLocks.delete(port);
    this._portLocks.delete(port + '-release');
    if (typeof release === 'function') release();
  }

  _nextPort(excludePorts = new Set()) {
    const candidates = (this.healthyPorts.length ? this.healthyPorts : this.ports)
      .filter((p) => !excludePorts.has(p))
      .filter((p) => !this._isCoolingDown(p));

    if (candidates.length === 0) return null;

    const port = candidates[this._nextIndex % candidates.length];
    this._nextIndex++;
    return port;
  }

  // ── Pre-warm ───────────────────────────────────────────

  async _preWarm() {
    log(`[pool] Pre-warming ${this.healthyPorts.length} sessions (sequential)...`, 'info');
    let warmed = 0;
    for (const port of this.healthyPorts) {
      const ok = await this._warmPort(port, `${this.sessionPrefix}-${port}`);
      if (ok) warmed++;
      if (warmed < this.healthyPorts.length) await sleep(2000);
    }

    if (warmed === 0) {
      log('[pool] Pre-warm: 0 ports warmed', 'warn');
    } else {
      log(`[pool] Pre-warmed ${warmed}/${this.healthyPorts.length} ports`, 'info');
    }
  }

  async _warmPort(port, session) {
    this._ownedSessions.set(session, port);
    try {
      const resp = await fetch(`http://localhost:${port}/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cmd: 'request.get',
          url: this.warmupUrl,
          maxTimeout: this.warmupTimeout,
          session,
        }),
        signal: AbortSignal.timeout(this.warmupTimeout + 15000),
      });

      if (!resp.ok) {
        log(`[pool] Warm :${port} HTTP ${resp.status} — marking unhealthy`, 'warn');
        this._markUnhealthy(port, `warmup HTTP ${resp.status}`);
        return false;
      }

      const data = await resp.json();

      // Check FlareSolverr reported success
      if (data.status !== 'ok') {
        log(`[pool] Warm :${port} FS error: ${data.message || 'unknown'} — marking unhealthy`, 'warn');
        this._markUnhealthy(port, `warmup FS: ${data.message || 'unknown'}`);
        return false;
      }

      // Verify we got real page content, not a CF block page
      const html = data.solution?.response || '';
      const isBlocked = html.includes('Just a moment') || html.includes('challenges.cloudflare.com');
      const hasContent = html.length > 500;

      if (isBlocked || !hasContent) {
        log(`[pool] Warm :${port} returned CF block or empty page (${html.length}B) — marking unhealthy`, 'warn');
        this._markUnhealthy(port, 'warmup returned CF block');
        return false;
      }

      // Success — mark warm, store cookies
      this._warmedUp.add(port);
      if (data.solution?.cookies?.length) {
        this._sessionCookies.set(port, data.solution.cookies);
      }
      log(`[pool] Warm :${port} OK (${html.length}B page)`, 'debug');
      return true;
    } catch (e) {
      log(`[pool] Warm :${port} error: ${e.message} — marking unhealthy`, 'warn');
      this._markUnhealthy(port, `warmup exception: ${e.message}`);
      return false;
    }
  }

  // ── JAV-owned session cleanup ─────────────────────────

  async _destroySession(port, session) {
    if (!session || !String(session).startsWith(this.sessionPrefix)) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'sessions.destroy', session }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.status !== 'ok') {
        log(`[pool] Session cleanup skipped/failed on :${port} for ${session}`, 'warn');
        return false;
      }
      log(`[pool] Destroyed JAV session ${session} on :${port}`, 'debug');
      this._ownedSessions.delete(session);
      return true;
    } catch (error) {
      log(`[pool] Session cleanup error on :${port}: ${error.message}`, 'warn');
      return false;
    }
  }

  async close() {
    const sessions = [...this._ownedSessions.entries()];
    for (const [session, port] of sessions) {
      await this._destroySession(port, session);
    }
    this._ownedSessions.clear();
    this._workerSessions.clear();
    this._workerMap.clear();
  }
}
