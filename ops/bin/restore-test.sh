#!/usr/bin/env bash
# Weekly proof that the backups restore: restores the latest backup into a scratch directory, starts it on a private
# socket with archiving off (it must never push WAL into the repository), compares it with production and reports to
# the radar-restore-test check. It starts failing for lack of room around 55% disk use, before the system check's 70%.
set -euo pipefail
readonly target=/var/lib/postgresql/radar-restore-test
readonly sockets=/run/radar-restore-test
readonly port=5499
readonly bin=/usr/lib/postgresql/18/bin
# Production keeps writing during the test (up to max_wal_size of WAL) and the scratch cluster writes its own.
readonly margin_kb=$((8 * 1024 * 1024))

# The ping URL holds the project's ping key: it reaches curl on standard input, never on the command line.
ping() {
  [[ -n "${HEALTHCHECKS_PING_BASE:-}" ]] || return 0
  printf 'url = "%s"\n' "${HEALTHCHECKS_PING_BASE%/}/radar-restore-test${1}?create=1" \
    | curl --config - --silent --show-error --max-time 10 --retry 3 --data-raw "${2:-}" >/dev/null || true
}
restored() { runuser -u postgres -- psql -X -At -h "${sockets}" -p "${port}" -d radar -c "$1"; }
production() { runuser -u postgres -- psql -X -At -d radar -c "$1"; }
cleanup() {
  if [[ -f "${target}/postmaster.pid" ]]; then
    runuser -u postgres -- "${bin}/pg_ctl" -D "${target}" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "${target}" "${sockets}"
}

log="$(mktemp)"
reported=false
failed_at="an unexpected step"
trap 'failed_at="line ${LINENO}: ${BASH_COMMAND}"' ERR
finish() {
  local status=$?
  if ((status != 0)) && [[ "${reported}" == false ]]; then ping /fail "restore-test.sh stopped at ${failed_at} (exit ${status})"; fi
  cleanup
  rm -f "${log}"
}
trap finish EXIT
fail() {
  reported=true
  echo "Restore test failed: $1" >&2
  ping /fail "$1"
  exit 1
}

[[ "$(id -u)" == 0 ]] || { echo "restore-test.sh must run as root" >&2; exit 1; }
ping /start
cleanup

# Measured by PostgreSQL rather than du, which fails when a file vanishes during the walk.
data_kb="$(production 'select (sum(pg_database_size(oid)) / 1024)::bigint from pg_database')"
free_kb="$(df --output=avail -k /var/lib/postgresql | tail -n 1 | tr -d ' ')"
((free_kb > data_kb + margin_kb)) || fail "Not enough free disk: ${free_kb} kB free for ${data_kb} kB of data and ${margin_kb} kB of margin"

install -d -o postgres -g postgres -m 700 "${target}" "${sockets}"
# Synchronous archive-get: production's asynchronous archive-push owns the spool and its lock.
runuser -u postgres -- pgbackrest --stanza=radar --pg1-path="${target}" --archive-async=n --type=immediate \
  --target-action=promote --archive-mode=off restore >"${log}" 2>&1 \
  || fail "pgbackrest restore failed: $(tail -c 2000 "${log}")"
# Debian keeps the configuration outside the data directory: the scratch cluster gets empty files and its settings on
# the command line. hot_standby is off because archive recovery refuses settings below the primary's, and
# timescaledb-tune raised max_worker_processes; the test needs connections only once the cluster is promoted.
runuser -u postgres -- sh -c ": >'${target}/postgresql.conf'; echo 'local all postgres peer' >'${target}/pg_hba.conf'; : >'${target}/pg_ident.conf'"
runuser -u postgres -- "${bin}/pg_ctl" -D "${target}" -w -t 1800 -l "${target}/restore-test.log" \
  -o "-p ${port} -c listen_addresses= -c unix_socket_directories=${sockets} -c hot_standby=off -c shared_preload_libraries=timescaledb -c timescaledb.telemetry_level=off -c archive_mode=off" \
  start >/dev/null || fail "The restored cluster did not start: $(tail -c 2000 "${target}/restore-test.log")"
for _ in $(seq 1 360); do
  if [[ "$(restored 'select pg_is_in_recovery()' 2>/dev/null || true)" == f ]]; then break; fi
  sleep 5
done
[[ "$(restored 'select pg_is_in_recovery()' 2>/dev/null || true)" == f ]] || fail "The restored cluster did not finish recovery in 30 min"

restored_games="$(restored 'select count(*) from games')"
production_games="$(production 'select count(*) from games')"
((restored_games * 100 >= production_games * 95)) || fail "Restored ${restored_games} games, production has ${production_games}"
production_runs="$(production 'select count(*) from job_runs')"
age="$(restored 'select coalesce(extract(epoch from now() - max(started_at))::bigint, -1) from job_runs')"
if ((production_runs > 0)) && ((age < 0 || age > 2 * 86400)); then
  fail "The newest restored job run is ${age} s old"
fi
version="$(restored "select extversion from pg_extension where extname = 'timescaledb'")"
ping "" "Restored ${restored_games}/${production_games} games, newest job run ${age} s old, TimescaleDB ${version}"
