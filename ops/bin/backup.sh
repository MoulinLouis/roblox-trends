#!/usr/bin/env bash
# Runs a pgBackRest backup (full or diff), checks the archive and reports to the radar-backup check.
set -euo pipefail
readonly type="${1:-}"
case "${type}" in
  full | diff) ;;
  *) echo "usage: backup.sh full|diff" >&2; exit 2 ;;
esac

# The ping URL holds the project's ping key: it reaches curl on standard input, never on the command line.
ping() {
  [[ -n "${HEALTHCHECKS_PING_BASE:-}" ]] || return 0
  printf 'url = "%s"\n' "${HEALTHCHECKS_PING_BASE%/}/radar-backup${1}?create=1" \
    | curl --config - --silent --show-error --max-time 10 --retry 3 --data-raw "${2:-}" >/dev/null || true
}

log="$(mktemp)"
reported=false
failed_at="an unexpected step"
trap 'failed_at="line ${LINENO}: ${BASH_COMMAND}"' ERR
finish() {
  local status=$?
  if ((status != 0)) && [[ "${reported}" == false ]]; then ping /fail "backup.sh stopped at ${failed_at} (exit ${status})"; fi
  rm -f "${log}"
}
trap finish EXIT
fail() {
  reported=true
  cat "${log}" >&2
  ping /fail "$1: $(tail -c 9000 "${log}")"
  exit 1
}

ping /start
runuser -u postgres -- pgbackrest --stanza=radar --type="${type}" backup >"${log}" 2>&1 || fail "pgbackrest ${type} backup failed"
runuser -u postgres -- pgbackrest --stanza=radar check >>"${log}" 2>&1 || fail "pgbackrest check failed"
runuser -u postgres -- pgbackrest --stanza=radar info >>"${log}" 2>&1 || fail "pgbackrest info failed"
ping "" "$(tail -c 10000 "${log}")"
