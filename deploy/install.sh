#!/usr/bin/env bash
# Install or update the static server (needs sudo): system user, server code
# in /opt/learn, systemd unit. Content is published separately by publish.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

id learn >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin learn
sudo install -d -m 0755 -o root -g root /opt/learn /var/lib/learn
sudo chown -R "$USER":"$USER" /var/lib/learn
sudo install -m 0644 -o root -g root server.mjs /opt/learn/server.mjs
sudo install -m 0644 -o root -g root deploy/learn.service /etc/systemd/system/learn.service
sudo systemctl daemon-reload
sudo systemctl enable learn.service >/dev/null
sudo systemctl restart learn.service
systemctl --no-pager --lines=0 status learn.service
