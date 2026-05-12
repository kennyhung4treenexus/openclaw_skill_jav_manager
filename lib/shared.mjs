import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// App root is parent of lib directory. The skill folder is only a thin guide/wrapper.
const APP_ROOT = process.env.JAV_MANAGER_APP_ROOT || resolve(__dirname, '..');

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
 * Backwards-compatible resolver used by existing stage code.
 * App/config files resolve under APP_ROOT; runtime files resolve under STATE_ROOT.
 * @param {string} relativePath - Path relative to app root or runtime state root
 * @returns {string} Absolute path
 */
export function getSkillPath(relativePath) {
  return isRuntimeRelativePath(relativePath)
    ? getStatePath(relativePath)
    : getAppPath(relativePath);
}

/**
 * Resolve a path relative to the workspace directory
 * @param {string} relativePath - Path relative to workspace root
 * @returns {string} Absolute path
 */
export function getWorkspacePath(relativePath) {
  return resolve(WORKSPACE_ROOT, relativePath);
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
  
  try {
    const axios = (await import('axios')).default;
    await axios.post(process.env.OPENCLAW_WEBHOOK_URL || 'http://127.0.0.1:18789/hooks/alerts', payload, {
      headers: {
        "Authorization": `Bearer ${process.env.OPENCLAW_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 5000
    });
    log(`Alert sent to Main Agent: ${severity} - ${context}`, 'info');
  } catch (e) {
    log(`Failed to send alert to Main Agent: ${e.message}`, 'error');
  }
}

/**
 * Restart FlareSolverr Docker containers before a pipeline run.
 * - Restarts containers to clear Chrome memory leaks
 * - Optionally clears persistent Docker volumes (if JAV_FLARESOLVERR_CLEAR_VOLUMES=true)
 * - Waits for all containers to be healthy before returning
 *
 * Volume strategy:
 *   Unique session prefix per run already prevents stale CF profiles from being reused.
 *   Clearing volumes every run forces Chrome to re-download CF challenge resources,
 *   making warmup significantly slower. Default is to NOT clear volumes.
 *   Clear periodically (monthly) or when CF blocks become frequent.
 *
 * @param {number[]} ports - FlareSolverr ports to restart
 * @param {object} [options]
 * @param {boolean} [options.clearVolumes=false] - Delete persistent browser profiles
 * @param {number} [options.healthTimeoutMs=60000] - Max wait for containers to be ready
 * @returns {Promise<{restarted: number, cleared: boolean, errors: string[]}>}
 */
export async function restartFlareSolverr(ports, options = {}) {
  const { clearVolumes = false, healthTimeoutMs = 60000 } = options;
  const errors = [];
  let restarted = 0;

  const containerPrefix = process.env.JAV_FLARESOLVERR_CONTAINER_PREFIX || 'flaresolverr';

  // Resolve container names: "flaresolverr", "flaresolverr-2", "flaresolverr-3", ...
  // Port 8191 → "flaresolverr", port 8192 → "flaresolverr-2", etc.
  const basePort = Math.min(...ports);
  const containerNames = ports.map((p) => {
    if (p === basePort && ports.length <= 1) return containerPrefix;
    const idx = ports.indexOf(p) + 1;
    return idx === 1 ? containerPrefix : `${containerPrefix}-${idx}`;
  });

  log(`[flaresolverr] Restarting ${containerNames.length} container(s): ${containerNames.join(', ')}…`, 'info');

  // ── Optional volume cleanup ──
  if (clearVolumes) {
    log('[flaresolverr] Clearing persistent browser volumes…', 'warn');
    for (const name of containerNames) {
      try {
        // Stop → remove anonymous volumes → recreate
        // Docker anonymous volumes are auto-created; we need to stop+remove container, then recreate
        // But we don't have the original docker run command. Use docker cp trick.
        // Simplest: stop, delete volume data, restart
        execSync(`docker stop ${name} 2>/dev/null || true`, { encoding: 'utf8', timeout: 30000 });

        // Find and clear the anonymous volume
        const mountInfo = execSync(
          `docker inspect ${name} --format '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Source}}{{end}}{{end}}'`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();

        if (mountInfo) {
          execSync(`sudo rm -rf ${mountInfo}/* ${mountInfo}/.[!.]* ${mountInfo}/..?* 2>/dev/null || true`, { timeout: 10000 });
          log(`[flaresolverr] Cleared volume for ${name}`, 'info');
        }
      } catch (e) {
        errors.push(`clear-volume ${name}: ${e.message}`);
      }
    }
  }

  // ── Restart containers ──
  for (const name of containerNames) {
    try {
      execSync(`docker restart ${name}`, { encoding: 'utf8', timeout: 30000 });
      restarted++;
      log(`[flaresolverr] Restarted ${name}`, 'info');
    } catch (e) {
      // Container may not exist — try to start if stopped
      try {
        execSync(`docker start ${name}`, { encoding: 'utf8', timeout: 30000 });
        restarted++;
        log(`[flaresolverr] Started ${name}`, 'info');
      } catch (e2) {
        errors.push(`restart ${name}: ${e.message}`);
      }
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

  while (healthy.size < ports.length && (Date.now() - start) < healthTimeoutMs) {
    for (const port of ports) {
      if (healthy.has(port)) continue;
      try {
        const res = execSync(
          `curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST http://localhost:${port}/v1`,
          { encoding: 'utf8', timeout: 15000 }
        ).trim();
        // FlareSolverr returns 405 (Method Not Allowed) on GET, 200 or 405 on POST
        // Some versions return 200 on POST /v1 with empty body, others 405
        if (res === '200' || res === '405' || res === '500') {
          healthy.add(port);
          log(`[flaresolverr] Port ${port} healthy (${healthy.size}/${ports.length})`, 'info');
        }
      } catch {
        // Not ready yet
      }
    }
    if (healthy.size < ports.length) {
      await sleep(2000);
    }
  }

  if (healthy.size < ports.length) {
    const unhealthy = ports.filter(p => !healthy.has(p)).join(',');
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
 * @param {number[]} [fallback=[8191,8192,8193]] - Default ports
 * @returns {number[]} Deduplicated port list
 */
export function parseFlaresolverrPorts(raw, fallback = [8191, 8192, 8193]) {
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
 * @param {number} [maxRetries=3] - Max attempts
 * @returns {Promise<any>} The Notion response
 */
export async function notionRetry(fn, label = 'notion', maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = [429, 502, 503, 504].includes(e.status) ||
        e.code === 'retry' || e.code === 'request_timeout';
      if (!retryable || attempt === maxRetries - 1) throw e;
      const wait = 1000 * 2 ** attempt;
      log(`[${label}] transient (${attempt + 1}/${maxRetries}), retry ${wait}ms: ${e.message}`, 'warn');
      await sleep(wait);
    }
  }
}

// Export the root paths for convenience
export const appRoot = APP_ROOT;
export const stateRoot = STATE_ROOT;
export const skillRoot = APP_ROOT; // backwards-compatible alias for older imports
export const workspaceRoot = WORKSPACE_ROOT;