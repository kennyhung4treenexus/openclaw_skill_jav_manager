#!/usr/bin/env node
// Dedicated, capability-reducing JAV operational-alert bridge.
// It uses one Edge device identity, requests only operator.write, accepts no
// destination or arbitrary RPC method from argv, and emits sanitized receipts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const gatewayClientModule = '/opt/alfred/runtime/openclaw/node_modules/openclaw/dist/plugin-sdk/gateway-runtime.js';
const expectedGatewayUrl = 'wss://openclaw-prd-sg-vm-01.tail253a51.ts.net';
const allowedModes = new Set(['failure', 'missed', 'incomplete', 'synthetic']);
const forbiddenScopes = new Set(['operator.admin', 'operator.approvals', 'operator.pairing']);
const maxLedgerEntries = 128;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function sanitizeError(cause) {
  return String(cause?.code ?? cause?.message ?? 'jav_alert_gateway_failed')
    .replace(/[^a-z0-9_.-]/gi, '_')
    .slice(0, 96);
}

function assertPrivateDirectory(directoryPath, code) {
  let stat;
  try { stat = fs.lstatSync(directoryPath); } catch { fail(code); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail(code);
}

function assertPrivateFile(filePath, code) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { fail(code); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail(code);
}

function requireEnvironment(action) {
  const gatewayUrl = (process.env.JAV_ALERT_GATEWAY_URL ?? '').trim();
  const deviceStateDir = (process.env.JAV_ALERT_DEVICE_STATE_DIR ?? '').trim();
  const runtimeStateDir = (process.env.JAV_MANAGER_STATE_DIR ?? '').trim();
  const target = (process.env.TELEGRAM_CHAT_ID ?? '').trim();
  const account = (process.env.JAV_ALERT_ACCOUNT ?? 'default').trim();
  const serviceFingerprint = (process.env.JAV_ALERT_SERVICE_FINGERPRINT ?? '').trim();

  if (gatewayUrl !== expectedGatewayUrl) fail('invalid_gateway_url');
  if (!path.isAbsolute(deviceStateDir) || !deviceStateDir.startsWith('/srv/alfred/shared/jav-manager/')) {
    fail('invalid_device_state_dir');
  }
  if (!path.isAbsolute(runtimeStateDir) || !runtimeStateDir.startsWith('/srv/alfred/shared/jav-manager/')) {
    fail('invalid_runtime_state_dir');
  }
  if (!/^[0-9]+$/.test(target)) fail('invalid_alert_target');
  if (account !== 'default') fail('invalid_alert_account');
  if (action !== 'check' && !/^[0-9a-f]{64}$/.test(serviceFingerprint)) {
    fail('invalid_service_fingerprint');
  }
  return { gatewayUrl, deviceStateDir, runtimeStateDir, target, account, serviceFingerprint };
}

function assertDeviceCredential(deviceStateDir) {
  // OpenClaw 2026.8.1 stores the device token in the shared SQLite state DB
  // and refuses to run while a legacy identity/device-auth.json exists.
  assertPrivateDirectory(deviceStateDir, 'unsafe_device_state_dir');
  const sqlitePath = path.join(deviceStateDir, 'state', 'openclaw.sqlite');
  let sqliteStat;
  try { sqliteStat = fs.statSync(sqlitePath); } catch { fail('device_token_store_unavailable'); }
  if (!sqliteStat.isFile() || sqliteStat.isSymbolicLink() || (sqliteStat.mode & 0o077) !== 0) fail('unsafe_device_token_store');
  let token;
  try {
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      const row = db.prepare('SELECT token FROM device_auth_tokens WHERE role = ? ORDER BY updated_at_ms DESC LIMIT 1').get('operator');
      token = row?.token;
    } finally { db.close(); }
  } catch { fail('device_token_store_unreadable'); }
  if (typeof token !== 'string' || token.length < 16) fail('missing_operator_device_token');
}

function validateLedger(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_alert_ledger');
  if (value.schemaVersion !== 1 || !Array.isArray(value.entries) || value.entries.length > maxLedgerEntries) {
    fail('invalid_alert_ledger');
  }
  const seen = new Set();
  for (const entry of value.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('invalid_alert_ledger');
    if (Object.keys(entry).sort().join(',') !== 'key,recordedAt,status') fail('invalid_alert_ledger');
    if (!/^[0-9a-f]{64}$/.test(entry.key ?? '') || seen.has(entry.key)) fail('invalid_alert_ledger');
    if (!new Set(['pending', 'delivered']).has(entry.status)) fail('invalid_alert_ledger');
    if (typeof entry.recordedAt !== 'string' || !Number.isFinite(Date.parse(entry.recordedAt))) {
      fail('invalid_alert_ledger');
    }
    seen.add(entry.key);
  }
  return value;
}

function readLedger(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return { schemaVersion: 1, entries: [] };
  assertPrivateFile(ledgerPath, 'unsafe_alert_ledger_file');
  let value;
  try { value = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch { fail('invalid_alert_ledger'); }
  return validateLedger(value);
}

function writeLedger(ledgerPath, value) {
  validateLedger(value);
  const directoryPath = path.dirname(ledgerPath);
  assertPrivateDirectory(directoryPath, 'unsafe_alert_ledger_directory');
  const temporaryPath = `${ledgerPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, ledgerPath);
    const directoryDescriptor = fs.openSync(directoryPath, 'r');
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch (cause) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve original failure */ }
    }
    try { fs.unlinkSync(temporaryPath); } catch { /* rename may have completed */ }
    throw cause;
  }
}

function acquireLedgerLock(lockPath) {
  assertPrivateDirectory(path.dirname(lockPath), 'unsafe_alert_ledger_directory');
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
  } catch (cause) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve lock failure */ }
    }
    if (cause?.code === 'EEXIST') fail('alert_ledger_locked');
    throw cause;
  }
  return () => {
    try { fs.unlinkSync(lockPath); } catch { fail('alert_ledger_unlock_failed'); }
  };
}

function semanticKey(mode, serviceFingerprint) {
  const day = new Date().toISOString().slice(0, 10);
  return crypto.createHash('sha256')
    .update(`edge-jav-alert-send-v1\n${mode}\n${serviceFingerprint}\n${day}`)
    .digest('hex');
}

function renderMessage(mode) {
  if (mode === 'synthetic') {
    return '⚠️ JAV Manager Edge watchdog 測試警報：GCP Gateway alert route 已驗證。';
  }
  const labels = {
    failure: 'pipeline 執行失敗',
    missed: '排程未觸發',
    incomplete: '排程未確認完成',
  };
  return `⚠️ JAV Manager Edge ${labels[mode]}。請由 GCP jav-ops 依 authority record 檢查 Edge service、journal 同 pipeline log。`;
}

async function connectClient(GatewayClient, env) {
  let resolveReady;
  let rejectReady;
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const client = new GatewayClient({
    url: env.gatewayUrl,
    env: { ...process.env, OPENCLAW_STATE_DIR: env.deviceStateDir },
    clientName: 'gateway-client',
    clientDisplayName: 'Edge JAV Watchdog Alert',
    platform: 'linux',
    deviceFamily: 'Linux',
    mode: 'backend',
    role: 'operator',
    scopes: ['operator.write'],
    requestTimeoutMs: 90_000,
    onHelloOk: (value) => {
      settled = true;
      const scopes = Array.isArray(value?.auth?.scopes) ? value.auth.scopes : [];
      if (!scopes.includes('operator.write') || scopes.some((scope) => forbiddenScopes.has(scope))) {
        rejectReady(new Error('device_scope_mismatch'));
        return;
      }
      resolveReady({ scopes });
    },
    onClose: () => {
      if (!settled) rejectReady(new Error('gateway_closed_before_hello'));
    },
  });
  client.start();
  let timer;
  try {
    const hello = await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('gateway_hello_timeout')), 20_000);
      }),
    ]);
    return { client, hello };
  } catch (cause) {
    client.stop();
    throw cause;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main() {
  const action = process.argv[2] ?? '';
  if (action !== 'check' && !allowedModes.has(action)) fail('invalid_alert_mode');
  if (process.argv.length !== 3) fail('unsupported_cli_shape');
  const env = requireEnvironment(action);
  fs.mkdirSync(env.deviceStateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(env.deviceStateDir, 0o700);
  assertPrivateDirectory(env.deviceStateDir, 'unsafe_device_state_dir');
  process.env.OPENCLAW_STATE_DIR = env.deviceStateDir;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;

  const { GatewayClient } = await import(gatewayClientModule);
  const { client, hello } = await connectClient(GatewayClient, env);
  try {
    if (action === 'check') {
      await client.request('health', {}, { timeoutMs: 20_000 });
      assertDeviceCredential(env.deviceStateDir);
      process.stdout.write(`${JSON.stringify({ status: 'ready', authenticated: true, operatorWrite: hello.scopes.includes('operator.write'), sent: false })}\n`);
      return;
    }

    assertDeviceCredential(env.deviceStateDir);
    const alertDir = path.join(env.runtimeStateDir, 'alerts');
    fs.mkdirSync(alertDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(alertDir, 0o700);
    const ledgerPath = path.join(alertDir, 'delivery-ledger.json');
    const lockPath = `${ledgerPath}.lock`;
    const key = semanticKey(action, env.serviceFingerprint);
    const releaseLock = acquireLedgerLock(lockPath);
    try {
      const ledger = readLedger(ledgerPath);
      const recorded = ledger.entries.find((entry) => entry.key === key);
      if (recorded?.status === 'pending') fail('alert_delivery_pending_recovery');
      if (recorded?.status === 'delivered') {
        process.stdout.write(`${JSON.stringify({ status: 'delivered', sent: false, deduplicated: true, receiptVerified: true, transport: 'gateway-wss' })}\n`);
        return;
      }
      if (ledger.entries.length >= maxLedgerEntries) fail('alert_ledger_full');
      const pending = {
        schemaVersion: 1,
        entries: [...ledger.entries, { key, status: 'pending', recordedAt: new Date().toISOString() }],
      };
      writeLedger(ledgerPath, pending);
      const result = await client.request('send', {
        to: env.target,
        message: renderMessage(action),
        channel: 'telegram',
        accountId: env.account,
        agentId: 'alfred-gate',
        sessionKey: `agent:alfred-gate:telegram:direct:${env.target}`,
        idempotencyKey: key,
      }, { timeoutMs: 60_000 });
      if (!result || typeof result !== 'object' || result.channel !== 'telegram' || !['string', 'number'].includes(typeof result.messageId)) {
        fail('gateway_send_receipt_invalid');
      }
      pending.entries[pending.entries.length - 1] = { key, status: 'delivered', recordedAt: new Date().toISOString() };
      writeLedger(ledgerPath, pending);
      process.stdout.write(`${JSON.stringify({ status: 'delivered', sent: true, deduplicated: false, receiptVerified: true, transport: 'gateway-wss' })}\n`);
    } finally {
      releaseLock();
    }
  } finally {
    await client.stopAndWait({ timeoutMs: 5000 }).catch(() => client.stop());
  }
}

main().catch((cause) => {
  process.stderr.write(`${JSON.stringify({ error: sanitizeError(cause) })}\n`);
  process.exitCode = 1;
});
