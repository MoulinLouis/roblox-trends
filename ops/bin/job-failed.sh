#!/usr/bin/env bash
# Sends the fail ping of a radar job whose unit failed: killed at TimeoutStartSec, crashed, or unable to start. A job
# that failed by itself already pinged; Healthchecks ignores the second fail.
set -euo pipefail
readonly job="${1:?usage: job-failed.sh <job>}"
if [[ -z "${HEALTHCHECKS_PING_BASE:-}" ]]; then
  echo "HEALTHCHECKS_PING_BASE is not set; radar-${job} failure not reported" >&2
  exit 1
fi
body="$(journalctl --unit "radar-job@${job}.service" --lines 40 --output cat --no-pager 2>&1 | tail -c 10000 || true)"
# The ping URL holds the project's ping key: it reaches curl on standard input, never on the command line.
printf 'url = "%s"\n' "${HEALTHCHECKS_PING_BASE%/}/radar-${job}/fail?create=1" \
  | curl --config - --fail --silent --show-error --max-time 10 --retry 3 --data-raw "${body}" >/dev/null
