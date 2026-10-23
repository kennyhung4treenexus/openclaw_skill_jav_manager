#!/usr/bin/env bash
set -Eeuo pipefail

PORTS_RAW="${JAV_FLARESOLVERR_PORTS:-8291,8292,8293}"
REPAIR=0
if [ "${1:-}" = "--repair" ]; then
  REPAIR=1
elif [ "${1:-}" = "--check-only" ]; then
  command -v docker >/dev/null
  command -v curl >/dev/null
  command -v systemctl >/dev/null
  echo "check OK: JAV FlareSolverr watchdog dependencies"
  exit 0
elif [ "$#" -gt 0 ]; then
  echo "Usage: alfred-jav-flaresolverr-watchdog.sh [--repair|--check-only]" >&2
  exit 64
fi

IFS=',' read -r -a PORTS <<< "$PORTS_RAW"
failed=0
for raw_port in "${PORTS[@]}"; do
  port="${raw_port//[[:space:]]/}"
  case "$port" in
    8291|8292|8293) ;;
    *) echo "Refusing non-JAV FlareSolverr port: $port" >&2; exit 64 ;;
  esac
  name="alfred-jav-flaresolverr-${port}"
  owner="$(docker inspect --format '{{ index .Config.Labels "alfred.owner" }}' "$name" 2>/dev/null || true)"
  labelled_port="$(docker inspect --format '{{ index .Config.Labels "alfred.port" }}' "$name" 2>/dev/null || true)"
  purpose="$(docker inspect --format '{{ index .Config.Labels "alfred.purpose" }}' "$name" 2>/dev/null || true)"
  binding="$(docker port "$name" 8191/tcp 2>/dev/null || true)"
  healthy=0
  if [ "$owner" = "jav-manager" ] &&
     [ "$labelled_port" = "$port" ] &&
     [ "$purpose" = "jav-active" ] &&
     [ "$binding" = "127.0.0.1:${port}" ] &&
     curl -fsS --max-time 10 "http://127.0.0.1:${port}/" >/dev/null; then
    healthy=1
  fi
  if [ "$healthy" -ne 1 ]; then
    failed=$((failed + 1))
    if [ "$REPAIR" -eq 1 ]; then
      systemctl restart "alfred-jav-flaresolverr@${port}.service"
    fi
  fi
done

if [ "$failed" -gt 0 ]; then
  echo "JAV FlareSolverr watchdog found ${failed} unhealthy instance(s)" >&2
  exit 1
fi
echo "JAV FlareSolverr watchdog passed ${#PORTS[@]}/${#PORTS[@]}"
