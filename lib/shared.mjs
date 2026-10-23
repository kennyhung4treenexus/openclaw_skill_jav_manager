import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// App root is parent of lib directory. The skill folder is only a thin guide/wrapper.
const APP_ROOT = process.env.JAV_MANAGER_APP_ROOT || resolve(__dirname, '..');
const CONFIG_ROOT = process.env.JAV_MANAGER_CONFIG_ROOT || APP_ROOT;

// Runtime state lives outside the app/skill tree so cache, logs, sessions, and indexes
// do not pollute AgentSkill folders or application source.
const STATE_ROOT = process.env.JAV_MANAGER_STATE_DIR || resolve(process.env.HOME || '', '.local/state/jav-manager');

// Default workspace path
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || resolve(process.env.HOME || '', '.openclaw/workspace');

function normalizeRelativePath(relativePath = '') {
  return String(relativePath).replace(/^\/+/, '');
}

function isRuntimeRelativePath(relativePath = '') {
  const p = normalizeRelativePath(relativePath);
  return p === 'cache' || p.startsWith('cache/') ||
    p === 'session' || p.startsWith('session/') ||
    p === 'logs' || p.startsWith('logs/') ||
    p === 'ingest-index.json';
}

function isConfigRelativePath(relativePath = '') {
  const p = normalizeRelativePath(relativePath);
  return [
    'config.json',
    'aliases.json',
    'favorites.json',
    'graveyard.json',
    'maker_aliases.json',
    'makers.json',
  ].includes(p);
}

/**
 * Resolve a path relative to the app root directory.
 * @param {string} relativePath - Path relative to app root
 * @returns {string} Absolute path
 */
export function getAppPath(relativePath) {
  return resolve(APP_ROOT, relativePath);
}

/**
 * Resolve a path relative to the runtime state directory.
 * Runtime logs are stored under app-logs/ to keep them separate from wrapper logs/.
 * @param {string} relativePath - Path relative to state root
 * @returns {string} Absolute path
 */
export function getStatePath(relativePath) {
  const p = normalizeRelativePath(relativePath);
  if (p === 'logs') return resolve(STATE_ROOT, 'app-logs');
  if (p.startsWith('logs/')) return resolve(STATE_ROOT, 'app-logs', p.slice('logs/'.length));
  return resolve(STATE_ROOT, p);
}

/**
 * Resolve mutable configuration outside an immutable release.
 * @param {string} relativePath - Path relative to the configured shared root
 * @returns {string} Absolute path
 */
export function getConfigPath(relativePath) {
  return resolve(CONFIG_ROOT, normalizeRelativePath(relativePath));
}

/**
 * Backwards-compatible resolver used by existing stage code.
 * App/config files resolve under APP_ROOT; runtime files resolve under STATE_ROOT.
 * @param {string} relativePath - Path relative to app root or runtime state root
 * @returns {string} Absolute path
 */
export function getSkillPath(relativePath) {
  if (isRuntimeRelativePath(relativePath)) return getStatePath(relativePath);
  if (isConfigRelativePath(relativePath)) return getConfigPath(relativePath);
  return getAppPath(relativePath);
}

/**
 * Resolve a path relative to the workspace directory
 * @param {string} relativePath - Path relative to workspace root
 * @returns {string} Absolute path
 */
export function getWorkspacePath(relativePath) {
  return resolve(WORKSPACE_ROOT, relativePath);
}

export function isShadowMode() {
  return /^(1|true|yes)$/i.test(process.env.JAV_SHADOW_MODE || '');
}

/**
 * Every stage must enter dry-run when the accepted Edge shadow fence is active.
 * This guard is intentionally duplicated at the stage boundary rather than
 * relying only on the CLI parser, because tests and operators may import a
 * stage module directly.
 */
export function assertShadowDryRun(stageName, dryRun) {
  if (isShadowMode() && dryRun !== true) {
    throw new Error(
      `JAV shadow mode blocks non-dry-run execution for ${stageName}; Notion/Telegram effects are disabled`
    );
  }
}

export function assertJavFlaresolverrPorts(ports) {
  const values = Array.isArray(ports) ? ports.map(Number) : [];
  if (
    values.length === 0 ||
    values.some((port) => !Number.isInteger(port) || port <= 0 || port > 65535)
  ) {
    throw new Error('A valid JAV FlareSolverr port list is required');
  }
  if (values.some((port) => [8191, 8192, 8193].includes(port))) {
    throw new Error('JAV runtime rejects News-owned FlareSolverr ports 8191-8193');
  }
  const allowedPorts = new Set([8291, 8292, 8293]);
  if (values.some((port) => !allowedPorts.has(port))) {
    throw new Error('JAV runtime accepts only JAV-owned FlareSolverr ports 8291-8293');
  }
  return values;
}

/**
 * Read JSON file with safe parsing
 * @param {string} filePath - Path to JSON file
 * @returns {any} Parsed JSON data
 * @throws {Error} If file cannot be read or JSON is invalid
 */
export function readJson(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Return empty object for non-existent files (common for control files)
      return {};
    }
    throw new Error(`Failed to read JSON from ${filePath}: ${error.message}`);
  }
}

/**
 * Write JSON file atomically using temp file + rename
 * @param {string} filePath - Path to write JSON file
 * @param {any} data - Data to write (will be JSON.stringify'd)
 * @param {number} [indent=2] - JSON indentation
 * @throws {Error} If write fails
 */
export function writeJsonAtomic(filePath, data, indent = 2) {
  const jsonString = JSON.stringify(data, null, indent) + '\n';
  const tempPath = filePath + '.tmp';
  
  try {
    // Ensure directory exists
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    // Write to temp file
    writeFileSync(tempPath, jsonString, 'utf8');
    
    // Atomic rename
    renameSync(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on error
    try {
      if (existsSync(tempPath)) {
        // Try to remove temp file
        import('fs').then(fs => fs.unlinkSync(tempPath));
      }
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    throw new Error(`Failed to write JSON atomically to ${filePath}: ${error.message}`);
  }
}

/**
 * Load configuration from config.json
 */
export function loadConfig() {
  return readJson(getSkillPath('config.json'));
}

/**
 * Logger helper that writes to dated log files
 * @param {string} message - Log message
 * @param {string} [level='info'] - Log level (info, warn, error, debug)
 */
export function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const levelUpper = level.toUpperCase();
  const logMessage = `[${timestamp}] [${levelUpper}] ${message}\n`;
  
  // Create logs directory if it doesn't exist
  const logsDir = getStatePath('logs');
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  
  // Create dated log file name
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
  const logFile = join(logsDir, `jav-manager-${dateStr}.log`);
  
  try {
    // Append to log file
    writeFileSync(logFile, logMessage, { flag: 'a', encoding: 'utf8' });
  } catch (error) {
    // Fallback to console if log file write fails
    console.error(`[LOG WRITE FAILED] ${logMessage.trim()}`);
  }
  
  // Also log to console for immediate visibility (except debug level)
  if (level !== 'debug' || process.env.DEBUG) {
    console.log(`[JAV-MANAGER:${levelUpper}] ${message}`);
  }
}

/**
 * Notify Main Agent of critical system errors
 * @param {string} severity - e.g., 'Fatal', 'Critical', 'High'
 * @param {string} context - Where the error occurred
 * @param {string} errorMessage - Description of the error
 */
export async function notifyAlert(severity, context, errorMessage) {
  const payload = {
    message: `⚠️ **[System Alert] Jav-Manager (${severity})**\n**Context:** ${context}\n**Error:** ${errorMessage}`
  };
  
  if (isShadowMode()) {
    const receiptPath = getStatePath(
      `shadow-alert-receipts/${Date.now()}-${process.pid}.json`
    );
    writeJsonAtomic(receiptPath, {
      schemaVersion: 1,
      status: 'suppressed-shadow',
      sent: false,
      severity,
      context,
      messageInputLength: String(errorMessage || '').length,
      recordedAt: new Date().toISOString(),
    });
    log(`Shadow alert suppressed and receipted: ${severity} - ${context}`, 'info');
    return { sent: false, shadow: true, receiptPath };
  }

  const webhookUrl = process.env.OPENCLAW_WEBHOOK_URL;
  const apiToken = process.env.OPENCLAW_API_TOKEN;
  if (!webhookUrl || !apiToken) {
    throw new Error('Authenticated OPENCLAW_WEBHOOK_URL and OPENCLAW_API_TOKEN are required');
  }

  try {
    const axios = (await import('axios')).default;
    await axios.post(webhookUrl, payload, {
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      timeout: 5000
    });
    log(`Alert sent to authenticated GCP route: ${severity} - ${context}`, 'info');
    return { sent: true, shadow: false };
  } catch (e) {
    log(`Failed to send alert to Main Agent: ${e.message}`, 'error');
    return { sent: false, shadow: false, error: e.message };
  }
}

/**
 * Explicitly restart already-running, ownership-validated JAV containers.
 * Normal runs leave container lifecycle to systemd and rotate only JAV sessions;
 * this legacy hook is disabled unless JAV_FLARESOLVERR_RESTART_ON_START=true.
 * Automatic volume deletion is never supported.
 *
 * @param {number[]} ports - FlareSolverr ports to restart
 * @param {object} [options]
 * @param {boolean} [options.clearVolumes=false] - Must remain false
 * @param {number} [options.healthTimeoutMs=60000] - Max wait for containers to be ready
 * @returns {Promise<{restarted: number, cleared: boolean, errors: string[]}>}
 */
export async function restartFlareSolverr(ports, options = {}) {
  const ownedPorts = assertJavFlaresolverrPorts(ports);
  const { clearVolumes = false, healthTimeoutMs = 60000 } = options;
  const errors = [];
  let restarted = 0;

  if (process.env.JAV_FLARESOLVERR_RESTART_ON_START !== 'true') {
    log('[flaresolverr] Start-time container restart is disabled; using session rotation', 'info');
    return { restarted: 0, cleared: false, errors, skipped: true };
  }
  if (clearVolumes) {
    throw new Error('Automatic FlareSolverr volume clearing is not supported');
  }

  const dockerBin = process.env.JAV_DOCKER_BIN || 'docker';
  const containerPrefix =
    process.env.JAV_FLARESOLVERR_CONTAINER_PREFIX || 'alfred-jav-flaresolverr';
  const containerNames = ownedPorts.map((port) => `${containerPrefix}-${port}`);

  log(`[flaresolverr] Restarting ${containerNames.length} container(s): ${containerNames.join(', ')}…`, 'info');

  // ── Restart containers ──
  for (let index = 0; index < containerNames.length; index++) {
    const name = containerNames[index];
    const port = ownedPorts[index];
    try {
      const inspect = JSON.parse(
        execFileSync(dockerBin, ['inspect', name], {
          encoding: 'utf8',
          timeout: 10000,
        })
      )[0];
      const labels = inspect?.Config?.Labels || {};
      const bindings = inspect?.HostConfig?.PortBindings?.['8191/tcp'] || [];
      const owned =
        labels['alfred.owner'] === 'jav-manager' &&
        labels['alfred.purpose'] === 'jav-active' &&
        labels['alfred.port'] === String(port) &&
        bindings.some((binding) =>
          binding?.HostIp === '127.0.0.1' && Number(binding?.HostPort) === port
        );
      if (!owned) {
        throw new Error(`${name} failed JAV ownership/loopback-port validation`);
      }
      execFileSync(dockerBin, ['restart', name], {
        encoding: 'utf8',
        timeout: 30000,
      });
      restarted++;
      log(`[flaresolverr] Restarted ${name}`, 'info');
    } catch (e) {
      errors.push(`restart ${name}: ${e.message}`);
    }
  }

  if (restarted === 0) {
    log('[flaresolverr] No containers restarted — they may not exist', 'error');
    return { restarted: 0, cleared: clearVolumes, errors };
  }

  // ── Health check: wait for all containers to accept POST requests ──
  log(`[flaresolverr] Waiting for ${restarted} container(s) to become healthy…`, 'info');
  const start = Date.now();
  const healthy = new Set();

  while (healthy.size < ownedPorts.length && (Date.now() - start) < healthTimeoutMs) {
    for (const port of ownedPorts) {
      if (healthy.has(port)) continue;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(10000),
        });
        if (response.ok) {
          healthy.add(port);
          log(`[flaresolverr] Port ${port} healthy (${healthy.size}/${ownedPorts.length})`, 'info');
        }
      } catch {
        // Not ready yet
      }
    }
    if (healthy.size < ownedPorts.length) {
      await sleep(2000);
    }
  }

  if (healthy.size < ownedPorts.length) {
    const unhealthy = ownedPorts.filter(p => !healthy.has(p)).join(',');
    errors.push(`Unhealthy ports after ${healthTimeoutMs}ms: ${unhealthy}`);
    log(`[flaresolverr] ⚠️ ${unhealthy} not ready`, 'warn');
  } else {
    log(`[flaresolverr] All containers healthy ✓`, 'info');
  }

  return { restarted, cleared: clearVolumes, errors };
}

/**
 * Promise-based sleep
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Parse FlareSolverr port list from env var string
 * @param {string|null|undefined} raw - Comma-separated port numbers
 * @param {number[]} [fallback=[8291,8292,8293]] - Default JAV-owned ports
 * @returns {number[]} Deduplicated port list
 */
export function parseFlaresolverrPorts(raw, fallback = [8291, 8292, 8293]) {
  if (!raw?.trim()) return fallback;
  const ports = [...new Set(
    raw.split(',')
      .map(p => parseInt(p.trim(), 10))
      .filter(Number.isInteger)
      .filter(p => p > 0 && p <= 65535)
  )];
  return ports.length > 0 ? ports : fallback;
}

/**
 * Retry a Notion API call on transient errors (429, 502-504).
 * @param {Function} fn - Async function returning the Notion response
 * @param {string} [label='notion'] - Label for logging
 * @param {number} [maxRetries=5] - Max attempts
 * @returns {Promise<any>} The Notion response
 */
export async function notionRetry(fn, label = 'notion', maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = [429, 502, 503, 504].includes(e.status) ||
        e.code === 'retry' || e.code === 'request_timeout';
      if (!retryable || attempt === maxRetries - 1) throw e;
      const retryAfter = e.headers?.get?.('retry-after');
      const retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter))
        ? Number(retryAfter) * 1000
        : 0;
      const wait = Math.max(1000 * 2 ** attempt, retryAfterMs);
      log(`[${label}] transient (${attempt + 1}/${maxRetries}), retry ${wait}ms: ${e.message}`, 'warn');
      await sleep(wait);
    }
  }
}

// Export the root paths for convenience
export const appRoot = APP_ROOT;
export const configRoot = CONFIG_ROOT;
export const stateRoot = STATE_ROOT;
export const skillRoot = APP_ROOT; // backwards-compatible alias for older imports
export const workspaceRoot = WORKSPACE_ROOT;
