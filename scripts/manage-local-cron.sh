#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner="$repository_root/scripts/run-local-job.sh"
log_directory="$repository_root/.data/logs"
log_file="$log_directory/local-scheduler.log"
marker_start="# BEGIN ROBLOX TREND RADAR"
marker_end="# END ROBLOX TREND RADAR"
action="${1:-install}"

current_crontab() {
  crontab -l 2>/dev/null || true
}

without_managed_block() {
  awk -v start="$marker_start" -v end="$marker_end" '
    $0 == start { managed = 1; next }
    $0 == end { managed = 0; next }
    !managed { print }
  '
}

install_cron() {
  mkdir -p "$log_directory" "$repository_root/.data/scheduler"
  local unmanaged
  unmanaged="$(current_crontab | without_managed_block)"
  {
    if [[ -n "$unmanaged" ]]; then
      printf '%s\n' "$unmanaged"
    fi
    printf '%s\n' "$marker_start"
    printf '%s\n' 'SHELL=/bin/bash'
    printf '%s\n' 'PATH=/home/playfade/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    printf '%s\n' 'MAILTO=""'
    printf '@reboot %q collect >> %q 2>&1\n' "$runner" "$log_file"
    printf '17,47 * * * * %q collect >> %q 2>&1\n' "$runner" "$log_file"
    printf '25 0,12,18 * * * %q analyze >> %q 2>&1\n' "$runner" "$log_file"
    printf '35 6-23 * * * %q daily >> %q 2>&1\n' "$runner" "$log_file"
    printf '%s\n' "$marker_end"
  } | crontab -
  printf 'Local scheduler installed for %s\n' "$repository_root"
}

remove_cron() {
  current_crontab | without_managed_block | crontab -
  printf 'Local scheduler removed; application data and logs were preserved.\n'
}

show_status() {
  printf 'cron service: '
  systemctl is-active cron 2>/dev/null || true
  printf 'managed schedule:\n'
  current_crontab | awk -v start="$marker_start" -v end="$marker_end" '
    $0 == start { managed = 1 }
    managed { print }
    $0 == end { managed = 0 }
  '
  printf 'log file: %s\n' "$log_file"
}

case "$action" in
  install)
    install_cron
    ;;
  remove)
    remove_cron
    ;;
  status)
    show_status
    ;;
  *)
    printf 'Usage: %s <install|status|remove>\n' "$0" >&2
    exit 2
    ;;
esac
