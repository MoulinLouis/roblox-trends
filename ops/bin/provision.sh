#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 server (arm64 or amd64) for the radar: PostgreSQL 18 with TimescaleDB, Node.js 24,
# pgBackRest, rclone, Tailscale, the radar and analysis users, the firewall and system limits. Safe to run again; it
# restarts PostgreSQL only when its configuration changed.
set -euo pipefail

readonly timescaledb_version=2.30.2
readonly node_major=24
ops="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ops
readonly cluster=/etc/postgresql/18/main

[[ "$(id -u)" == 0 ]] || { echo "provision.sh must run as root" >&2; exit 1; }
# shellcheck source=/dev/null
. /etc/os-release
[[ "${VERSION_ID}" == 24.04 ]] || { echo "Ubuntu 24.04 is required (TimescaleDB community packages)" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

# Package repositories: PGDG (PostgreSQL, pgBackRest), Timescale, NodeSource, Tailscale.
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg jq git ufw unattended-upgrades postgresql-common rclone openssl
install -d -m 755 /etc/apt/keyrings
/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey | gpg --dearmor --yes -o /etc/apt/keyrings/timescaledb.gpg
echo "deb [signed-by=/etc/apt/keyrings/timescaledb.gpg] https://packagecloud.io/timescale/timescaledb/ubuntu/ noble main" \
  >/etc/apt/sources.list.d/timescaledb.list
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${node_major}.x nodistro main" \
  >/etc/apt/sources.list.d/nodesource.list
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
apt-get update -q

# TimescaleDB stays on the version CI tests (held). PostgreSQL itself is upgraded by hand too (docs/operations.md):
# PGDG is not an unattended-upgrades origin, because a minor release once broke the extension ABI.
pinned() { apt-cache madison "$1" | awk -v prefix="${timescaledb_version}~" 'index($3, prefix) == 1 && !found { print $3; found = 1 }'; }
timescaledb="$(pinned timescaledb-2-postgresql-18)"
loader="$(pinned timescaledb-2-loader-postgresql-18)"
if [[ -z "${timescaledb}" || -z "${loader}" ]]; then
  echo "TimescaleDB ${timescaledb_version} is not packaged for $(dpkg --print-architecture)" >&2
  exit 1
fi
apt-get install -y -q --allow-change-held-packages postgresql-18 postgresql-client-18 \
  "timescaledb-2-postgresql-18=${timescaledb}" "timescaledb-2-loader-postgresql-18=${loader}" timescaledb-tools \
  pgbackrest nodejs tailscale
apt-mark hold timescaledb-2-postgresql-18 timescaledb-2-loader-postgresql-18 >/dev/null

# Users and directories. The radar home holds the npm cache; root owns the mirror clone and the releases, so the radar
# user can neither re-point /opt/radar/current nor change what root runs from a release (deploy.sh).
id radar >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/radar --shell /usr/sbin/nologin radar
id analysis >/dev/null 2>&1 || useradd --create-home --shell /bin/bash analysis
install -d -o analysis -g analysis -m 700 /home/analysis/.ssh
if [[ ! -f /home/analysis/.ssh/authorized_keys ]]; then
  install -o analysis -g analysis -m 600 /root/.ssh/authorized_keys /home/analysis/.ssh/authorized_keys
fi
install -d -o root -g radar -m 750 /etc/radar
install -d -o root -g root -m 755 /opt/radar /opt/radar/releases

# PostgreSQL: memory sized to leave room for the Node.js jobs, the dashboard and a build.
# A missing file (conf.d is empty on a fresh cluster) must not stop the script under pipefail.
configuration() { (cat "${cluster}"/postgresql.conf "${cluster}"/conf.d/*.conf "${cluster}"/pg_hba.conf "${cluster}"/pg_ident.conf 2>/dev/null || true) | sha256sum; }
before="$(configuration)"
tune_target=(--pg-version=18)
if [[ -x /usr/lib/postgresql/18/bin/pg_config ]]; then tune_target=(--pg-config=/usr/lib/postgresql/18/bin/pg_config); fi
timescaledb-tune --quiet --yes "${tune_target[@]}" --conf-path="${cluster}/postgresql.conf" --memory=5GB --cpus=4 >/dev/null
install -o postgres -g postgres -m 644 "${ops}/postgresql/90-radar.conf" "${cluster}/conf.d/90-radar.conf"
install -o postgres -g postgres -m 640 "${ops}/postgresql/pg_hba.conf" "${cluster}/pg_hba.conf"
install -o postgres -g postgres -m 640 "${ops}/postgresql/pg_ident.conf" "${cluster}/pg_ident.conf"
after="$(configuration)"
systemctl enable --quiet postgresql
if [[ "${before}" != "${after}" ]]; then systemctl restart postgresql@18-main; fi

# System: swap for build peaks, a bounded journal, daily security updates with a night reboot when one needs it.
if [[ ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
fi
swapon --show=NAME --noheadings | grep -qx /swapfile || swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
echo 'vm.swappiness = 10' >/etc/sysctl.d/90-radar.conf
sysctl --quiet --system
install -d /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=2G\n' >/etc/systemd/journald.conf.d/90-radar.conf
systemctl restart systemd-journald
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' >/etc/apt/apt.conf.d/20auto-upgrades
# 04:48 sits between job starts (ops/systemd timers); a reboot costs at most one poll slot.
cat >/etc/apt/apt.conf.d/52radar-unattended-upgrades <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:48";
EOF

# SSH: keys only, root by key (the image allows passwords for other users). sshd keeps the first value it reads and
# includes the drop-ins in name order, so this one sorts before any cloud-init drop-in, such as 50-cloud-init.conf.
cat >/etc/ssh/sshd_config.d/01-radar.conf <<'EOF'
# Managed by ops/bin/provision.sh: keys only, root by key.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t
# grep without -q reads the whole output: an early exit would SIGPIPE sshd and, under pipefail, fail the check.
sshd -T | grep -x 'passwordauthentication no' >/dev/null || { echo "An sshd drop-in read earlier still allows passwords" >&2; exit 1; }
systemctl reload ssh

# Firewall: only the tailnet reaches the server. Public SSH stays open until Tailscale access is proven (Task B2
# removes it and leaves the marker, so a later run does not reopen it).
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow in on tailscale0 >/dev/null
ufw allow 41641/udp comment 'Tailscale direct connections' >/dev/null
if [[ ! -f /etc/radar/public-ssh-closed ]]; then ufw allow 22/tcp comment 'public SSH until Tailscale is verified' >/dev/null; fi
ufw --force enable >/dev/null
systemctl enable --now --quiet tailscaled

echo "PostgreSQL $(runuser -u postgres -- psql -XAtc 'show server_version'), TimescaleDB ${timescaledb}," \
  "Node.js $(node --version), npm $(npm --version), $(pgbackrest version), Tailscale $(tailscale version | sed -n 1p)"
