#!/usr/bin/env bash
set -Eeuo pipefail

PATH="/usr/local/bin:/usr/bin:/bin"
CHECK_ONLY=0
DRY_RUN=0
for argument in "$@"; do
  case "$argument" in
    --check-only) CHECK_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Unknown argument: $argument" >&2; exit 64 ;;
  esac
done

ALERT_SCRIPT="${JAV_PIPELINE_ALERT_SCRIPT:-/srv/alfred/prod/jav-manager/current/deploy/jav-pipeline-alert.sh}"
if [ ! -x "$ALERT_SCRIPT" ]; then
  echo "JAV alert script missing or not executable" >&2
  exit 72
fi
if [ "$CHECK_ONLY" -eq 1 ]; then
  "$ALERT_SCRIPT" synthetic --check-only
  echo "check OK: JAV watchdog and alert dependencies"
  exit 0
fi

active="$(systemctl --user is-active jav-pipeline.service 2>/dev/null || true)"
result="$(systemctl --user show jav-pipeline.service -p Result --value 2>/dev/null || true)"
status="$(systemctl --user show jav-pipeline.service -p ExecMainStatus --value 2>/dev/null || true)"
if [ "$active" = "active" ] || { [ "$result" = "success" ] && [ "$status" = "0" ]; }; then
  echo "JAV pipeline service state is healthy"
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  exec "$ALERT_SCRIPT" synthetic --dry-run
fi
exec "$ALERT_SCRIPT" incomplete
