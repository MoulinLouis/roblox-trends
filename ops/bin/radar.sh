#!/usr/bin/env bash
# Runs an npm script of the live release as the radar user with the production environment, for example
# `radar status`. Collection jobs run through systemd instead (`systemctl start radar-job@poll`), which never overlaps
# a run with the timer's.
set -euo pipefail
[[ $# -ge 1 ]] || { echo "usage: radar <npm script> [arguments]" >&2; exit 2; }
[[ "$(id -u)" == 0 ]] || { echo "radar must run as root" >&2; exit 1; }
set -a
# shellcheck source=/dev/null
. /etc/radar/radar.env
set +a
cd /opt/radar/current
exec runuser -u radar -- npm run --silent "$1" -- "${@:2}"
