#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

PINNED_NODE_ROOT="/opt/alfred/runtime/node-v24.19.0-linux-x64"
PATH="${PINNED_NODE_ROOT}/bin:/usr/local/bin:/usr/bin:/bin"
NODE_BIN="${JAV_NODE_BIN:-${PINNED_NODE_ROOT}/bin/node}"

APP_ROOT="${JAV_MANAGER_APP_ROOT:-/srv/alfred/prod/jav-manager/current}"
RELEASE_ROOT="${JAV_MANAGER_RELEASE_ROOT:-/srv/alfred/prod/jav-manager/releases}"
CONFIG_ROOT="${JAV_MANAGER_CONFIG_ROOT:-/srv/alfred/shared/jav-manager/config}"
STATE_ROOT="${JAV_MANAGER_STATE_DIR:-/srv/alfred/shared/jav-manager/state}"
LOG_ROOT="${JAV_MANAGER_LOG_DIR:-/srv/alfred/shared/jav-manager/logs}"
ENV_FILE="${JAV_MANAGER_ENV_FILE:-${CONFIG_ROOT}/runtime.env}"
TIMEOUT_DURATION="${JAV_PIPELINE_TIMEOUT_DURATION:-5h}"
LOCK_FILE="${STATE_ROOT}/jav-pipeline.lock"
CHECK_ONLY=0
SHADOW_UAT=0
AUTOMATIC_RUN_REQUESTED="${JAV_AUTOMATIC_RUN:-0}"

usage() {
  echo "Usage: run-jav-pipeline.sh [--check-only] [--shadow-uat <command> [args...]]"
}

if [ "${1:-}" = "--check-only" ]; then
  CHECK_ONLY=1
  shift
elif [ "${1:-}" = "--shadow-uat" ]; then
  SHADOW_UAT=1
  shift
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 127
  }
}

for command in flock timeout date readlink grep; do
  require_cmd "$command"
done
if [ ! -x "$NODE_BIN" ]; then
  if [ -z "${JAV_NODE_BIN+x}" ] && command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  else
    echo "Pinned JAV Node runtime missing or not executable: $NODE_BIN" >&2
    exit 127
  fi
fi

if [ ! -d "$APP_ROOT" ] || [ ! -f "$APP_ROOT/index.mjs" ]; then
  echo "JAV Manager release entrypoint missing: $APP_ROOT/index.mjs" >&2
  exit 72
fi
app_real="$(readlink -f "$APP_ROOT")"
release_real="$(readlink -f "$RELEASE_ROOT")"
case "$app_real" in
  "$release_real"/*) ;;
  *)
    echo "JAV Manager current release escapes release root" >&2
    exit 74
    ;;
esac

if [ ! -d "$CONFIG_ROOT" ] || [ ! -f "$CONFIG_ROOT/config.json" ]; then
  echo "Shared JAV config missing: $CONFIG_ROOT/config.json" >&2
  exit 72
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "JAV runtime environment file missing: $ENV_FILE" >&2
  exit 72
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  obsolete_fragment=".her""mes/skills"
  if grep -R -F -n --include='*.sh' --include='*.mjs' \
      "$obsolete_fragment" "$APP_ROOT" >/dev/null 2>&1; then
    echo "Obsolete Hermes path detected" >&2
    exit 74
  fi
  echo "check OK: immutable release, shared config/state, runtime env, and dependencies"
  exit 0
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
export JAV_MANAGER_APP_ROOT="$APP_ROOT"
export JAV_MANAGER_CONFIG_ROOT="$CONFIG_ROOT"
export JAV_MANAGER_STATE_DIR="$STATE_ROOT"
export JAV_MANAGER_ENV_FILE="$ENV_FILE"

if [ "$AUTOMATIC_RUN_REQUESTED" = "1" ]; then
  now_hm="$(date +%H%M)"
  minute="$(date +%M)"
  case "$now_hm" in
    05[01][0-9]|11[01][0-9]|17[01][0-9]|23[01][0-9]) ;;
    *)
      echo "stale automatic slot skipped at $(date --iso-8601=seconds)"
      exit 0
      ;;
  esac
  if [ "$minute" -gt 19 ]; then
    echo "stale automatic slot skipped at $(date --iso-8601=seconds)"
    exit 0
  fi
fi

mkdir -p "$STATE_ROOT" "$LOG_ROOT"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another JAV pipeline run is active; refusing overlap" >&2
  exit 75
fi

if [ "$SHADOW_UAT" -eq 1 ]; then
  if [ "${JAV_SHADOW_MODE:-}" != "1" ] && [ "${JAV_SHADOW_MODE:-}" != "true" ]; then
    echo "Shadow UAT requires JAV_SHADOW_MODE=true" >&2
    exit 78
  fi
  if [ "$#" -eq 0 ]; then
    echo "Shadow UAT command is required" >&2
    exit 64
  fi
  has_dry_run=0
  for argument in "$@"; do
    if [ "$argument" = "--dry-run" ]; then
      has_dry_run=1
    fi
  done
  if [ "$has_dry_run" -ne 1 ]; then
    echo "Shadow UAT requires --dry-run" >&2
    exit 78
  fi
  exec timeout --preserve-status --signal=TERM --kill-after=30s 30m \
    "$NODE_BIN" "$APP_ROOT/index.mjs" "$@"
fi

exec timeout --preserve-status --signal=TERM --kill-after=120s "$TIMEOUT_DURATION" \
  "$NODE_BIN" --max-old-space-size=8192 "$APP_ROOT/index.mjs" all
