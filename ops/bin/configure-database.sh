#!/usr/bin/env bash
# Creates the radar roles and database, the extension and the read-only grants (ops/postgresql/*.sql), and the
# application environment file. Safe to run again.
set -euo pipefail
ops="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ops

[[ "$(id -u)" == 0 ]] || { echo "configure-database.sh must run as root" >&2; exit 1; }
# The files are read by this root shell and given on stdin: the postgres user cannot read the release directory.
psql_admin() { runuser -u postgres -- psql -X --quiet -v ON_ERROR_STOP=1 "$@"; }
psql_admin <"${ops}/postgresql/roles.sql"
if [[ "$(psql_admin -At -c "select count(*) from pg_database where datname = 'radar'")" == 0 ]]; then
  runuser -u postgres -- createdb --owner=radar radar
fi
psql_admin -d radar <"${ops}/postgresql/database.sql"

if [[ ! -f /etc/radar/radar.env ]]; then
  install -o root -g radar -m 640 /dev/null /etc/radar/radar.env
  cat >/etc/radar/radar.env <<'EOF'
# Peer authentication on the local socket: no password exists for the radar role.
DATABASE_URL=postgresql://radar@/radar?host=/var/run/postgresql
NEXT_TELEMETRY_DISABLED=1
EOF
fi
