#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# JAV Manager post-pipeline FlareSolverr handling.
# The application rotates and destroys its own sessions. This wrapper may
# validate or restart only containers carrying both JAV ownership labels and
# the exact loopback port binding. It never creates/removes containers.

DOCKER_BIN="${JAV_DOCKER_BIN:-/usr/bin/docker}"
SYSTEMCTL_BIN="${JAV_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
CURL_BIN="${JAV_CURL_BIN:-/usr/bin/curl}"
SS_BIN="${JAV_SS_BIN:-/usr/bin/ss}"
AWK_BIN="${JAV_AWK_BIN:-/usr/bin/awk}"
PORTS_RAW="${JAV_FLARESOLVERR_PORTS:-8291,8292,8293}"
PREFIX="${JAV_FLARESOLVERR_CONTAINER_PREFIX:-alfred-jav-flaresolverr}"
ACTION="${JAV_FLARESOLVERR_CLEANUP_ACTION:-validate-owned}"
SYSTEMD_TEMPLATE="/etc/systemd/system/alfred-jav-flaresolverr@.service"

docker_backend_configured=false
if [ -n "${JAV_DOCKER_BIN:-}" ]; then
  docker_backend_configured=true
fi

case "$PREFIX" in
  *[!A-Za-z0-9_.-]*|'')
    echo "[post-pipeline] Invalid JAV container prefix" >&2
    exit 64
    ;;
esac

case "$ACTION" in
  validate-owned|restart-owned) ;;
  *)
    echo "[post-pipeline] Unsupported cleanup action: $ACTION" >&2
    exit 64
    ;;
esac

if [ "$ACTION" = "restart-owned" ] && [ "$docker_backend_configured" != true ]; then
  echo "[post-pipeline] restart-owned requires an explicit privileged JAV_DOCKER_BIN" >&2
  exit 64
fi

IFS=',' read -r -a PORTS <<< "$PORTS_RAW"
if [ "${#PORTS[@]}" -eq 0 ]; then
  echo "[post-pipeline] No JAV FlareSolverr ports configured" >&2
  exit 64
fi

validated=0
restarted=0
backend="systemd"
for raw_port in "${PORTS[@]}"; do
  port="${raw_port//[[:space:]]/}"
  case "$port" in
    8291|8292|8293) ;;
    *)
      echo "[post-pipeline] Refusing non-JAV FlareSolverr port" >&2
      exit 64
      ;;
  esac

  name="${PREFIX}-${port}"
  if [ "$docker_backend_configured" = true ]; then
    backend="docker"
    owner="$("$DOCKER_BIN" inspect --format '{{ index .Config.Labels "alfred.owner" }}' "$name")"
    labelled_port="$("$DOCKER_BIN" inspect --format '{{ index .Config.Labels "alfred.port" }}' "$name")"
    purpose="$("$DOCKER_BIN" inspect --format '{{ index .Config.Labels "alfred.purpose" }}' "$name")"
    binding="$("$DOCKER_BIN" port "$name" 8191/tcp)"

    if [ "$owner" != "jav-manager" ] || [ "$labelled_port" != "$port" ] || [ "$purpose" != "jav-active" ]; then
      echo "[post-pipeline] Ownership validation failed for $name" >&2
      exit 74
    fi
    if [ "$binding" != "127.0.0.1:${port}" ]; then
      echo "[post-pipeline] Loopback binding validation failed for $name" >&2
      exit 74
    fi

    if [ "$ACTION" = "restart-owned" ]; then
      "$DOCKER_BIN" restart "$name" >/dev/null
      restarted=$((restarted + 1))
    fi
  else
    unit="alfred-jav-flaresolverr@${port}.service"
    if ! "$SYSTEMCTL_BIN" is-active --quiet "$unit"; then
      echo "[post-pipeline] Inactive JAV FlareSolverr unit: $unit" >&2
      exit 74
    fi

    fragment="$("$SYSTEMCTL_BIN" show "$unit" --property=FragmentPath --value)"
    exec_start="$("$SYSTEMCTL_BIN" show "$unit" --property=ExecStart --value)"
    if [ "$fragment" != "$SYSTEMD_TEMPLATE" ]; then
      echo "[post-pipeline] Unexpected unit provenance for $unit" >&2
      exit 74
    fi

    for required in \
      "--name ${name}" \
      "--label alfred.owner=jav-manager" \
      "--label alfred.port=${port}" \
      "--label alfred.purpose=jav-active" \
      "--publish 127.0.0.1:${port}:8191/tcp"
    do
      case "$exec_start" in
        *"$required"*) ;;
        *)
          echo "[post-pipeline] Unit ownership contract failed for $unit" >&2
          exit 74
          ;;
      esac
    done

    if ! "$SS_BIN" -H -ltn "sport = :${port}" |
      "$AWK_BIN" -v expected="127.0.0.1:${port}" '$4 == expected { found=1 } END { exit(found ? 0 : 1) }'
    then
      echo "[post-pipeline] Loopback listener validation failed for $unit" >&2
      exit 74
    fi
    if ! "$CURL_BIN" -fsS --max-time 10 "http://127.0.0.1:${port}/" >/dev/null; then
      echo "[post-pipeline] Health validation failed for $unit" >&2
      exit 74
    fi
  fi

  validated=$((validated + 1))
done

echo "[post-pipeline] JAV-owned instances validated=${validated} restarted=${restarted} backend=${backend}; News resources untouched"
