import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'jav-edge-shadow-'));
const configRoot = join(temp, 'config');
const stateRoot = join(temp, 'state');
process.env.JAV_MANAGER_CONFIG_ROOT = configRoot;
process.env.JAV_MANAGER_STATE_DIR = stateRoot;
process.env.JAV_MANAGER_APP_ROOT = root;
process.env.JAV_SHADOW_MODE = 'true';

const shared = await import('../lib/shared.mjs');

test('shared config and state resolve outside the immutable release', () => {
  assert.equal(shared.getConfigPath('config.json'), join(configRoot, 'config.json'));
  assert.equal(shared.getSkillPath('config.json'), join(configRoot, 'config.json'));
  assert.equal(shared.getSkillPath('cache/item.json'), join(stateRoot, 'cache/item.json'));
  assert.equal(shared.getAppPath('index.mjs'), join(root, 'index.mjs'));
});

test('shadow mode fails closed for product effects and News ports', () => {
  assert.throws(
    () => shared.assertShadowDryRun('uat', false),
    /requires --dry-run|blocks non-dry-run/
  );
  assert.doesNotThrow(() => shared.assertShadowDryRun('uat', true));
  assert.throws(
    () => shared.assertJavFlaresolverrPorts([8191, 8292, 8293]),
    /rejects News-owned/
  );
  assert.throws(
    () => shared.assertJavFlaresolverrPorts([8291, 8294]),
    /only JAV-owned FlareSolverr ports 8291-8293/
  );
  assert.deepEqual(shared.assertJavFlaresolverrPorts([8291, 8292, 8293]), [8291, 8292, 8293]);
  process.env.JAV_SHADOW_MODE = 'false';
  assert.throws(
    () => shared.assertJavFlaresolverrPorts([8191]),
    /rejects News-owned/
  );
  process.env.JAV_SHADOW_MODE = 'true';
});

test('shadow alerts are locally receipted and never sent', async () => {
  const result = await shared.notifyAlert('Synthetic', 'edge-shadow-test', 'do not deliver');
  assert.equal(result.sent, false);
  assert.equal(result.shadow, true);
  assert.equal(existsSync(result.receiptPath), true);
  const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
  assert.equal(receipt.status, 'suppressed-shadow');
  assert.equal(receipt.sent, false);
});

test('shadow alert entrypoint receipts dry-run and rejects live delivery', () => {
  const alertState = join(temp, 'alert-entrypoint-state');
  const alertScript = join(root, 'deploy/jav-pipeline-alert.sh');
  const env = {
    ...process.env,
    JAV_MANAGER_APP_ROOT: root,
    JAV_MANAGER_STATE_DIR: alertState,
    JAV_NODE_BIN: process.execPath,
    JAV_SHADOW_MODE: 'true',
  };
  const dryRun = spawnSync('bash', [alertScript, 'synthetic', '--dry-run'], { env, encoding: 'utf8' });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /synthetic alert receipt/);
  const receipts = readdirSync(join(alertState, 'alerts')).filter((name) => name.endsWith('.json'));
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(readFileSync(join(alertState, 'alerts', receipts[0]), 'utf8'));
  assert.equal(receipt.sent, false);
  assert.equal(receipt.routeContract, 'authenticated-gcp');

  const live = spawnSync('bash', [alertScript, 'synthetic'], { env, encoding: 'utf8' });
  assert.equal(live.status, 78);
  assert.match(live.stderr, /shadow mode suppresses live alert delivery/i);
});

test('every stage carries a direct shadow dry-run guard', () => {
  for (const stage of [
    '01-ingest.mjs',
    '02-enrich.mjs',
    '03-verify-url.mjs',
    '04-rankings.mjs',
    '05-archive.mjs',
    '06-notify.mjs',
    '07-delete.mjs',
  ]) {
    const source = readFileSync(join(root, 'stages', stage), 'utf8');
    assert.match(source, /assertShadowDryRun\(/, stage);
  }
});

test('FlareSolverr rotation destroys only tracked JAV sessions and never invokes Docker', () => {
  const source = readFileSync(join(root, 'lib/net/flaresolverr-pool.mjs'), 'utf8');
  assert.match(source, /options\.ports \|\| \[8291, 8292, 8293\]/);
  assert.match(source, /sessions\.destroy/);
  assert.match(source, /_ownedSessions/);
  assert.doesNotMatch(source, /child_process|docker restart|docker start|docker stop|docker rm/);
});

test('post-pipeline validates exact ownership and refuses an unowned container', () => {
  const bin = join(temp, 'bin');
  const docker = join(bin, 'docker');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    docker,
    '#!/usr/bin/env bash\n' +
      'if [ "$1" = inspect ]; then echo not-jav; exit 0; fi\n' +
      'if [ "$1" = port ]; then echo 127.0.0.1:8291; exit 0; fi\n' +
      'exit 0\n'
  );
  chmodSync(docker, 0o700);
  const run = spawnSync('bash', [join(root, 'post-pipeline.sh')], {
    env: {
      ...process.env,
      JAV_DOCKER_BIN: docker,
      JAV_FLARESOLVERR_PORTS: '8291',
      JAV_FLARESOLVERR_CONTAINER_PREFIX: 'alfred-jav-flaresolverr',
    },
    encoding: 'utf8',
  });
  assert.equal(run.status, 74);
  assert.match(run.stderr, /Ownership validation failed/);

  const newsPortRun = spawnSync('bash', [join(root, 'post-pipeline.sh')], {
    env: { ...process.env, JAV_DOCKER_BIN: docker, JAV_FLARESOLVERR_PORTS: '8191' },
    encoding: 'utf8',
  });
  assert.equal(newsPortRun.status, 64);
  assert.match(newsPortRun.stderr, /Refusing non-JAV/);
});

test('post-pipeline validates the unprivileged systemd contract without Docker access', () => {
  const bin = join(temp, 'systemd-bin');
  const systemctl = join(bin, 'systemctl');
  const ss = join(bin, 'ss');
  const curl = join(bin, 'curl');
  const docker = join(bin, 'docker');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    systemctl,
    '#!/usr/bin/env bash\n' +
      'if [ "$1" = is-active ]; then exit 0; fi\n' +
      'if [[ "$*" = *FragmentPath* ]]; then echo /etc/systemd/system/alfred-jav-flaresolverr@.service; exit 0; fi\n' +
      'if [[ "$*" = *ExecStart* ]]; then echo "--name alfred-jav-flaresolverr-8291 --label alfred.owner=jav-manager --label alfred.port=8291 --label alfred.purpose=jav-active --publish 127.0.0.1:8291:8191/tcp"; exit 0; fi\n' +
      'exit 1\n'
  );
  writeFileSync(ss, '#!/usr/bin/env bash\necho "LISTEN 0 4096 127.0.0.1:8291 0.0.0.0:*"\n');
  writeFileSync(curl, '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(docker, '#!/usr/bin/env bash\nexit 99\n');
  chmodSync(systemctl, 0o700);
  chmodSync(ss, 0o700);
  chmodSync(curl, 0o700);
  chmodSync(docker, 0o700);

  const run = spawnSync('bash', [join(root, 'post-pipeline.sh')], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      JAV_SYSTEMCTL_BIN: systemctl,
      JAV_SS_BIN: ss,
      JAV_CURL_BIN: curl,
      JAV_FLARESOLVERR_PORTS: '8291',
      JAV_FLARESOLVERR_CONTAINER_PREFIX: 'alfred-jav-flaresolverr',
    },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /validated=1 restarted=0 backend=systemd/);
});

test('deployment assets are immutable-layout, no-stale, isolated and unapplied by design', () => {
  const runner = readFileSync(join(root, 'deploy/run-jav-pipeline.sh'), 'utf8');
  const timer = readFileSync(join(root, 'deploy/jav-pipeline.timer'), 'utf8');
  const watchdogTimer = readFileSync(join(root, 'deploy/jav-pipeline-watchdog.timer'), 'utf8');
  const fsUnit = readFileSync(join(root, 'deploy/alfred-jav-flaresolverr@.service'), 'utf8');
  const post = readFileSync(join(root, 'post-pipeline.sh'), 'utf8');
  const runtimeEnv = readFileSync(join(root, 'deploy/runtime.env.example'), 'utf8');
  const alert = readFileSync(join(root, 'deploy/jav-pipeline-alert.sh'), 'utf8');
  const alertBridge = readFileSync(join(root, 'deploy/jav-gateway-alert.mjs'), 'utf8');
  const sharedSource = readFileSync(join(root, 'lib/shared.mjs'), 'utf8');
  const javWatchdog = readFileSync(join(root, 'deploy/alfred-jav-flaresolverr-watchdog.sh'), 'utf8');
  assert.doesNotMatch(runner, /\.hermes\/skills/);
  assert.match(runner, /release escapes release root|escapes release root/);
  assert.match(runner, /PINNED_NODE_ROOT="\/opt\/alfred\/runtime\/node-v24\.19\.0-linux-x64"/);
  assert.match(runner, /NODE_BIN=.*PINNED_NODE_ROOT.*\/bin\/node/);
  assert.match(runner, /"\$NODE_BIN" "\$APP_ROOT\/index\.mjs"/);
  const automaticCapture = runner.indexOf('AUTOMATIC_RUN_REQUESTED="${JAV_AUTOMATIC_RUN:-0}"');
  const mutableEnvSource = runner.indexOf('. "$ENV_FILE"');
  const staleGuard = runner.indexOf('[ "$AUTOMATIC_RUN_REQUESTED" = "1" ]');
  assert.ok(automaticCapture >= 0 && automaticCapture < mutableEnvSource);
  assert.ok(mutableEnvSource < staleGuard);
  assert.doesNotMatch(runtimeEnv, /^JAV_AUTOMATIC_RUN=/m);
  assert.match(runtimeEnv, /^JAV_ALERT_GATEWAY_URL=wss:\/\//m);
  assert.match(runtimeEnv, /^JAV_ALERT_DEVICE_STATE_DIR=\/srv\/alfred\/shared\/jav-manager\//m);
  assert.doesNotMatch(runtimeEnv, /JAV_ALERT_AUTH_HEADER_FILE|JAV_ALERT_TEST_MODE/);
  assert.doesNotMatch(alert, /curl|JAV_ALERT_ROUTE_URL|JAV_ALERT_AUTH_HEADER_FILE/);
  assert.match(alert, /jav-gateway-alert\.mjs/);
  assert.match(alertBridge, /scopes: \['operator\.write'\]/);
  assert.match(alertBridge, /client\.request\('send'/);
  assert.match(runtimeEnv, /^JAV_ALERT_ACCOUNT=default$/m);
  assert.match(alertBridge, /JAV_ALERT_ACCOUNT \?\? 'default'/);
  assert.match(alertBridge, /account !== 'default'/);
  assert.match(alertBridge, /agentId: 'alfred-gate'/);
  assert.match(alertBridge, /sessionKey: `agent:alfred-gate:telegram:direct:/);
  assert.doesNotMatch(alertBridge, /agentId: 'main'|agent:main:telegram:direct|account !== 'lab'/);
  assert.match(alertBridge, /forbiddenScopes/);
  assert.doesNotMatch(alertBridge, /operator\.admin.*scopes:|operator\.pairing.*scopes:/);
  assert.doesNotMatch(alertBridge, /process\.argv\[[^\]]+\].*(target|channel|account)/i);
  assert.match(timer, /Persistent=false/);
  assert.match(watchdogTimer, /Persistent=false/);
  assert.match(fsUnit, /alfred\.owner=jav-manager/);
  assert.match(fsUnit, /alfred\.purpose=jav-active/);
  assert.doesNotMatch(fsUnit, /alfred\.purpose=jav-shadow/);
  assert.match(fsUnit, /ExecCondition=\/usr\/bin\/test %i -ge 8291/);
  assert.match(fsUnit, /ExecCondition=\/usr\/bin\/test %i -le 8293/);
  assert.match(fsUnit, /127\.0\.0\.1:%i:8191/);
  assert.match(fsUnit, /@sha256:[0-9a-f]{64}/);
  assert.doesNotMatch(post, /docker\s+(rm|run)|flaresolverr-2|flaresolverr-3/);
  assert.match(post, /alfred\.owner/);
  assert.match(post, /alfred\.purpose/);
  assert.match(post, /purpose.*jav-active/s);
  assert.match(post, /FragmentPath/);
  assert.match(post, /127\.0\.0\.1:\$\{port\}/);
  assert.match(sharedSource, /labels\['alfred\.purpose'\] === 'jav-active'/);
  assert.match(javWatchdog, /purpose.*jav-active/s);
  assert.doesNotMatch(runner, /30m\s+\+/);
});

test('CLI executes through an immutable current-release symlink', () => {
  const current = join(temp, 'current-release');
  symlinkSync(root, current, 'dir');
  const run = spawnSync(process.execPath, [join(current, 'index.mjs'), 'help'], {
    env: { ...process.env, JAV_MANAGER_APP_ROOT: current },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /JAV Manager - 7-stage sync pipeline/);
  assert.match(run.stdout, /Usage:/);
});

test('CLI exits non-zero when a stage returns structured error status', () => {
  const errorState = join(temp, 'structured-error-state');
  mkdirSync(configRoot, { recursive: true });
  mkdirSync(errorState, { recursive: true });
  writeFileSync(join(configRoot, 'config.json'), '{"favorites":[]}\n');
  const run = spawnSync(process.execPath, [join(root, 'index.mjs'), 'enrich', '--dry-run'], {
    env: {
      ...process.env,
      JAV_MANAGER_APP_ROOT: root,
      JAV_MANAGER_CONFIG_ROOT: configRoot,
      JAV_MANAGER_STATE_DIR: errorState,
      JAV_SHADOW_MODE: 'true',
      NOTION_TOKEN: 'ae10-dummy-token',
      NOTION_DATABASE_ID: '00000000-0000-0000-0000-000000000000',
    },
    encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Failed to read ingest items/);
  assert.match(run.stderr, /returned status error/);
});
