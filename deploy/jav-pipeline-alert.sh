#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

PINNED_NODE_ROOT="/opt/alfred/runtime/node-v24.19.0-linux-x64"
PATH="${PINNED_NODE_ROOT}/bin:/usr/local/bin:/usr/bin:/bin"
NODE_BIN="${JAV_NODE_BIN:-${PINNED_NODE_ROOT}/bin/node}"
MODE="${1:-failure}"
if [ "$#" -gt 0 ]; then shift; fi
DRY_RUN=0
CHECK_ONLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done

case "$MODE" in
  failure|missed|incomplete|synthetic) ;;
  *) echo "Invalid alert mode" >&2; exit 64 ;;
esac

STATE_ROOT="${JAV_MANAGER_STATE_DIR:-/srv/alfred/shared/jav-manager/state}"
ALERT_DIR="${STATE_ROOT}/alerts"
APP_ROOT="${JAV_MANAGER_APP_ROOT:-/srv/alfred/prod/jav-manager/current}"
BRIDGE="${APP_ROOT}/deploy/jav-gateway-alert.mjs"

for command in date sha256sum systemctl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Missing required command: $command" >&2
    exit 127
  }
done
if [ ! -x "$NODE_BIN" ] || [ ! -f "$BRIDGE" ]; then
  echo "Authenticated JAV Gateway alert bridge is incomplete" >&2
  exit 72
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  exec "$NODE_BIN" "$BRIDGE" check
fi
if [ "${JAV_SHADOW_MODE:-}" = "true" ] || [ "${JAV_SHADOW_MODE:-}" = "1" ]; then
  [ "$DRY_RUN" -eq 1 ] || {
    echo "JAV shadow mode suppresses live alert delivery" >&2
    exit 78
  }
fi

mkdir -p "$ALERT_DIR"
service_state="$(systemctl --user show jav-pipeline.service -p ActiveState -p Result -p ExecMainStatus --value 2>/dev/null | tr '\n' '/' || true)"
fingerprint="$(printf '%s' "$MODE|${service_state:-unknown}" | sha256sum | awk '{print $1}')"
receipt="$ALERT_DIR/${fingerprint}.json"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '{"status":"synthetic","sent":false,"routeContract":"authenticated-gcp","fingerprint":"%s"}\n' "$fingerprint" > "$receipt"
  echo "synthetic alert receipt: $receipt"
  exit 0
fi

response_file="$ALERT_DIR/${fingerprint}.response"
JAV_ALERT_SERVICE_FINGERPRINT="$fingerprint" "$NODE_BIN" "$BRIDGE" "$MODE" > "$response_file"
"$NODE_BIN" -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "delivered" || value.receiptVerified !== true || value.transport !== "gateway-wss") process.exit(1);
  const receipt = {
    status: "delivered",
    sent: value.sent === true,
    deduplicated: value.deduplicated === true,
    receiptVerified: true,
    transport: "gateway-wss",
    fingerprint: process.argv[2],
  };
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
' "$response_file" "$fingerprint" > "$receipt"
echo "authenticated alert receipt: $receipt"
