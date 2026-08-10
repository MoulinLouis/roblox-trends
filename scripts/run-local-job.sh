#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
job="${1:-}"
runtime_directory="$repository_root/.data/scheduler"
lock_file="$runtime_directory/jobs.lock"

mkdir -p "$runtime_directory"
cd "$repository_root"

log() {
  printf '%s level=%s job=%s message=%q\n' "$(date --iso-8601=seconds)" "$1" "$job" "$2"
}

case "$job" in
  collect | analyze | daily)
    ;;
  *)
    printf 'Usage: %s <collect|analyze|daily>\n' "$0" >&2
    exit 2
    ;;
esac

exec 9>"$lock_file"
if ! flock -n 9; then
  log info "Skipped because another local job is running"
  exit 0
fi

log info "Started"

if [[ "$job" == "collect" ]]; then
  npm run collect
  log info "Completed"
  exit 0
fi

if [[ "$job" == "analyze" ]]; then
  npm run analyze
  npm run brief
  log info "Completed"
  exit 0
fi

current_hour="$(date +%H)"
if ((10#$current_hour < 6)); then
  log info "Skipped before the daily processing window"
  exit 0
fi

daily_stamp="$runtime_directory/daily-$(date +%F).done"
if [[ -f "$daily_stamp" ]]; then
  log info "Skipped because daily processing already completed"
  exit 0
fi

npm run analyze
npm run brief
npm run report
npm run maintenance
touch "$daily_stamp"
log info "Completed"
