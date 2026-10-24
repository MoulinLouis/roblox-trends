#!/usr/bin/env bash
# Deploys the newest commit of the deploy branch once its CI run passed: builds it next to the live release, pauses
# the job timers only when the commit brings migrations, then switches the live release. Run every 5 minutes by
# radar-deploy.timer, and by hand for the first deployment. Exits 0 when there is nothing to deploy.
set -euo pipefail

readonly repository=MoulinLouis/roblox-trends
readonly branch="${RADAR_DEPLOY_BRANCH:-main}"
readonly root=/opt/radar
# Root's own clone, outside the radar home: the radar user can change neither what is deployed nor what root runs.
readonly mirror="${root}/repo.git"
readonly releases="${root}/releases"
readonly current="${root}/current"
readonly keep_releases=3
# A release younger than this may still run a job (explore runs up to 55 minutes) or the legacy import: it is never pruned.
readonly minimum_release_age_minutes=120
readonly job_timers=(radar-census.timer radar-poll.timer radar-votes.timer radar-charts.timer radar-explore.timer radar-thumbnails.timer)
readonly job_wait_seconds=300
readonly migration_attempts=5

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# The ping URL holds the project's ping key: it reaches curl on standard input, never on the command line.
ping() {
  [[ -n "${HEALTHCHECKS_PING_BASE:-}" ]] || return 0
  printf 'url = "%s"\n' "${HEALTHCHECKS_PING_BASE%/}/radar-deploy${1}?create=1" \
    | curl --config - --silent --show-error --max-time 10 --retry 3 --data-raw "${2:-}" >/dev/null \
    || log "Healthchecks ping failed"
}

# Job timers that are enabled must run whenever no deploy is in its critical section. Pausing collection on purpose
# means disabling them (docs/operations.md), which this never undoes.
start_job_timers() {
  local timer timers=()
  for timer in "${job_timers[@]}"; do
    if systemctl is-enabled --quiet "${timer}" 2>/dev/null; then timers+=("${timer}"); fi
  done
  if ((${#timers[@]} > 0)); then systemctl start "${timers[@]}" || log "Could not start ${timers[*]}"; fi
}

reported=false
failed_at="an unexpected step"
trap 'failed_at="line ${LINENO}: ${BASH_COMMAND}"' ERR
finish() {
  local status=$?
  if ((status != 0)) && [[ "${reported}" == false ]]; then ping /fail "deploy.sh stopped at ${failed_at} (exit ${status})"; fi
  start_job_timers
}
fail() {
  reported=true
  log "Deploy failed: $1"
  ping /fail "$1"
  exit 1
}
as_radar() { runuser -u radar -- "$@"; }

[[ "$(id -u)" == 0 ]] || { echo "deploy.sh must run as root" >&2; exit 1; }
# One deploy at a time: a manual run and the timer's must not build the same release.
exec 9>/run/radar-deploy.lock
flock --nonblock 9 || { log "Another deploy is running"; exit 0; }
trap finish EXIT
set -a
# shellcheck source=/dev/null
. /etc/radar/radar.env
set +a

if [[ ! -d "${mirror}" ]]; then
  git clone --quiet --mirror "https://github.com/${repository}.git" "${mirror}" || fail "Could not clone ${repository}"
fi
# GitHub can be briefly unreachable: the next run retries, and nothing is deployed meanwhile.
if ! git -C "${mirror}" fetch --quiet --prune origin; then
  log "git fetch failed; retrying on the next run"
  ping "" "git fetch failed; nothing deployed"
  exit 0
fi
target="$(git -C "${mirror}" rev-parse --verify "refs/heads/${branch}^{commit}")"
live_path="$(readlink -e "${current}" || true)"
live="${live_path:+$(basename "${live_path}")}"
# .deployed is written last, so a deploy that stopped after the switch is completed by the next run.
if [[ "${target}" == "${live}" && -f "${current}/.deployed" ]]; then
  ping "" "Up to date at ${live}"
  exit 0
fi
if [[ -f "${releases}/${target}.failed" ]]; then
  fail "The build of ${target} failed earlier (${releases}/${target}.failed); push a fix"
fi

# Only a commit whose CI job "validate" passed is deployed.
if ! checks="$(curl --fail --silent --show-error --max-time 20 --header 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/${repository}/commits/${target}/check-runs?check_name=validate")"; then
  log "GitHub API unreachable; retrying on the next run"
  ping "" "GitHub API unreachable; nothing deployed"
  exit 0
fi
ci="$(jq -r '[(.check_runs // [])[] | select(.name == "validate")] | sort_by(.started_at) | last
  | "\(.status // "missing") \(.conclusion // "none")"' <<<"${checks}" 2>/dev/null || echo "unreadable none")"
read -r ci_status ci_conclusion <<<"${ci}"
if [[ "${ci_status}" != completed || "${ci_conclusion}" != success ]]; then
  log "CI for ${target} is ${ci_status}/${ci_conclusion}; not deploying"
  ping "" "CI for ${target} is ${ci_status}/${ci_conclusion}; live release ${live:-none}"
  exit 0
fi

# Build outside the live release, at low priority so the jobs keep their pace. A failed build is not retried until a
# new commit arrives.
release="${releases}/${target}"
if [[ ! -f "${release}/.built" ]]; then
  log "Building ${target}"
  rm -rf "${release}"
  install -d -m 755 "${release}"
  git -C "${mirror}" archive "${target}" | tar -xf - -C "${release}" || fail "Could not export ${target}"
  # The build runs as radar, so it can write its dependencies and output.
  chown -R radar:radar "${release}"
  build_log="${releases}/${target}.log"
  if ! as_radar env -C "${release}" nice -n 10 npm ci --no-audit --no-fund >"${build_log}" 2>&1 \
    || ! as_radar env -C "${release}" nice -n 10 npm run build >>"${build_log}" 2>&1; then
    mv -f "${build_log}" "${releases}/${target}.failed"
    rm -rf "${release}"
    fail "Build of ${target} failed: $(tail -c 2000 "${releases}/${target}.failed")"
  fi
  rm -f "${build_log}"
  # Code that runs during the build (npm install scripts, next build) runs as radar: it must not plant anything root
  # later runs or follows. Root takes the release, replaces ops/ (ops/bin, ops/systemd) with its own copy, drops any
  # planted marker and refuses a planted symlink before handing back only what Next.js writes at runtime.
  chown -R root:root "${release}"
  rm -rf "${release}/ops" "${release}/.built" "${release}/.deployed"
  git -C "${mirror}" archive "${target}" ops | tar -xf - -C "${release}" || fail "Could not export the operations files of ${target}"
  if [[ -L "${release}/.next" || -L "${release}/.next/cache" ]]; then
    echo "The build left a symbolic link at .next or .next/cache" >"${releases}/${target}.failed"
    rm -rf "${release}"
    fail "The build of ${target} left a symbolic link at .next or .next/cache"
  fi
  if [[ -d "${release}/.next/cache" ]]; then
    chown -R radar:radar "${release}/.next/cache"
  else
    install -d -o radar -g radar "${release}/.next/cache"
  fi
  touch "${release}/.built"
fi

# Job timers pause only when the release brings migrations, so a schema change never races a job's statements.
if [[ -z "${live}" ]] || ! git -C "${mirror}" diff --quiet "${live}" "${target}" -- drizzle; then
  for timer in "${job_timers[@]}"; do systemctl stop "${timer}" 2>/dev/null || true; done
  # Running jobs keep their own release (never pruned while young); waiting lets the migration take its locks.
  waited=0
  # Captured, not piped into grep -q: an early grep exit would SIGPIPE systemctl and, under pipefail, end the wait.
  while [[ -n "$(systemctl list-units --no-legend --state=activating,active 'radar-job@*.service')" ]]; do
    if ((waited >= job_wait_seconds)); then
      log "Jobs still running after ${job_wait_seconds} s; migrating anyway (lock_timeout protects them)"
      break
    fi
    sleep 5
    waited=$((waited + 5))
  done
fi
# Migrations must stay compatible with the previous release, which may still be running a job (docs/operations.md).
migrated=false
for attempt in $(seq 1 "${migration_attempts}"); do
  if as_radar env -C "${release}" npm run --silent db:migrate; then
    migrated=true
    break
  fi
  log "Migration attempt ${attempt} of ${target} failed"
  sleep 30
done
[[ "${migrated}" == true ]] || fail "Migrations of ${target} failed; ${live:-no release} stays live"

ln -sfn "${release}" "${current}.next"
mv -T "${current}.next" "${current}"
cp -r "${release}/ops/systemd/." /etc/systemd/system/
systemctl daemon-reload
ln -sfn "${current}/ops/bin/radar.sh" /usr/local/bin/radar
if systemctl is-enabled --quiet radar-web.service; then
  systemctl restart radar-web.service
  for _ in $(seq 1 30); do
    if curl --fail --silent --max-time 5 --output /dev/null http://127.0.0.1:3000/; then break; fi
    sleep 1
  done
  curl --fail --silent --max-time 5 --output /dev/null http://127.0.0.1:3000/ || fail "The dashboard of ${target} does not answer"
fi
start_job_timers
touch "${release}/.deployed"

# Keep the newest releases, the live one and every release young enough to still run a job or an import.
find "${releases}" -mindepth 1 -maxdepth 1 -type d -mmin "+${minimum_release_age_minutes}" -printf '%T@ %p\n' \
  | sort -rn | tail -n "+$((keep_releases + 1))" | cut -d' ' -f2- | while read -r directory; do
    [[ "$(readlink -e "${directory}")" == "$(readlink -e "${current}")" ]] || rm -rf "${directory}"
  done
log "Deployed ${target}"
ping "" "Deployed ${target} (was ${live:-none})"
