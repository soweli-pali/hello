#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu 24.04 server. Run as root:
#   curl -fsSL https://raw.githubusercontent.com/soweli-pali/hello/claude/hello-world-server-wzk8ks/deploy/setup.sh | bash
# (or copy this file over and `bash setup.sh`). Safe to run again: it updates the code and keeps the world.
#
# What you get:
#   - a `hello` user owning /opt/hello (code) and /var/lib/hello (the world, agents' memory, backups)
#   - the world server as a service, reachable only over Tailscale (private to your devices)
#   - an agents service that runs /var/lib/hello/agents.json while you're away
#   - nightly backups of the world, kept for two weeks, and a firewall
set -euo pipefail
REPO=${REPO:-https://github.com/soweli-pali/hello.git}
BRANCH=${BRANCH:-claude/hello-world-server-wzk8ks}
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ufw sqlite3 ca-certificates docker.io >/dev/null
systemctl enable --now docker >/dev/null
if ! node -v 2>/dev/null | grep -qE '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

echo "== user and code"
id hello >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/hello --shell /usr/sbin/nologin hello
git config --global --add safe.directory /opt/hello 2>/dev/null || true   # the code belongs to the hello user
if [ -d /opt/hello/.git ]; then
  git -C /opt/hello fetch -q origin "$BRANCH"
  git -C /opt/hello checkout -q -B "$BRANCH" "origin/$BRANCH"
else git clone -q --branch "$BRANCH" "$REPO" /opt/hello; fi
chown -R hello:hello /opt/hello
echo "code at $(git -C /opt/hello log --oneline -1)"
sudo -u hello bash -c 'cd /opt/hello && npm ci --omit=dev --silent'

echo "== tailscale (open the link it prints to add this server to your tailnet)"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
tailscale status >/dev/null 2>&1 || tailscale up --ssh
TS_IP=$(tailscale ip -4 | head -1)

echo "== settings (/etc/hello.env; edit it to add your API key)"
if [ ! -f /etc/hello.env ]; then
  cat > /etc/hello.env <<EOF
HOST=$TS_IP
PORT=7777
DATA_DIR=/var/lib/hello
JOIN_KEY=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
# SEED=7                      # terrain seed, used only when the world is first created
ANTHROPIC_API_KEY=            # for agents with "provider": "anthropic"
EOF
  chmod 640 /etc/hello.env; chgrp hello /etc/hello.env
fi
set -a; . /etc/hello.env; set +a

if [ ! -f /var/lib/hello/agents.json ]; then
  cat > /var/lib/hello/agents.json <<EOF
{
  "server": "http://$TS_IP:7777",
  "joinKey": "$JOIN_KEY",
  "globalTokens": 20000000,
  "maxConcurrency": 4,
  "agents": [
    { "name": "Wren", "provider": "bot", "seed": 1 }
  ]
}
EOF
  chown hello:hello /var/lib/hello/agents.json
fi

echo "== services"
cat > /etc/systemd/system/hello.service <<'EOF'
[Unit]
Description=hello world server
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=hello
WorkingDirectory=/opt/hello
EnvironmentFile=/etc/hello.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/hello-agents.service <<'EOF'
[Unit]
Description=hello agents (runs /var/lib/hello/agents.json)
After=hello.service
Requires=hello.service

[Service]
User=hello
WorkingDirectory=/opt/hello
EnvironmentFile=/etc/hello.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/runner.ts /var/lib/hello/agents.json
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

echo "== nightly backups (/var/lib/hello/backups, 14 kept)"
cat > /etc/cron.daily/hello-backup <<'EOF'
#!/bin/sh
mkdir -p /var/lib/hello/backups
sqlite3 /var/lib/hello/world.db ".backup /var/lib/hello/backups/world-$(date +%F).db"
chown -R hello:hello /var/lib/hello/backups
ls -1t /var/lib/hello/backups/world-*.db | tail -n +15 | xargs -r rm --
EOF
chmod +x /etc/cron.daily/hello-backup

echo "== guys in containers (hello-guy)"
mkdir -p /var/lib/hello/guys
printf '#!/bin/sh\nexec /usr/bin/node --disable-warning=ExperimentalWarning /opt/hello/src/guy.ts "$@"\n' > /usr/local/bin/hello-guy
chmod +x /usr/local/bin/hello-guy
docker pull -q node:22-slim >/dev/null; docker pull -q python:3.12-slim >/dev/null

echo "== firewall: ssh, everything over tailscale, and the guys' door to the world"
# public SSH only on a fresh install (once you lock it down, updates leave it locked)
ufw status | grep -q "Status: active" || ufw allow OpenSSH >/dev/null
ufw allow in on tailscale0 >/dev/null
ufw allow in on docker0 to any port "${PORT:-7777}" proto tcp >/dev/null
ufw --force enable >/dev/null

echo "== world updates (each applied once)"
sudo -u hello DATA_DIR=/var/lib/hello /usr/bin/node --disable-warning=ExperimentalWarning /opt/hello/src/migrate.ts

echo "== hello-update: run this any time to bring everything up to date"
cat > /usr/local/bin/hello-update <<'UPDATE_EOF'
#!/bin/sh
# bring the code, the world's settings and the services up to date (safe to run any time)
set -e
git config --global --add safe.directory /opt/hello 2>/dev/null || true
B=$(git -C /opt/hello rev-parse --abbrev-ref HEAD)
git -C /opt/hello fetch -q origin "$B"
git -C /opt/hello checkout -q -B "$B" "origin/$B"
BRANCH="$B" exec bash /opt/hello/deploy/setup.sh
UPDATE_EOF
chmod +x /usr/local/bin/hello-update

systemctl daemon-reload
systemctl enable --now hello >/dev/null
systemctl restart hello   # pick up new code
systemctl enable hello-agents >/dev/null; systemctl restart hello-agents
sleep 3
echo
echo "Done. The world: http://$TS_IP:7777  (open it on any device in your tailnet)"
echo "Agents:   edit /var/lib/hello/agents.json, then: systemctl restart hello-agents"
echo "API key:  edit /etc/hello.env, then: systemctl restart hello-agents"
echo "Guys in containers: hello-guy add <folder>   (see CREATE.md); hello-guy list"
echo "Update everything later: hello-update"
echo "Logs:     journalctl -u hello -u hello-agents -f"
echo "Stop all agents at once: touch /var/lib/hello/STOP   (rm it to let them run again)"
