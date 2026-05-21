#!/bin/bash
# Copyright (c) 2026 Brad Root
# SPDX-License-Identifier: Elastic-2.0
#
# Lurker — DigitalOcean one-shot deploy (cloud-init user-data)
# ============================================================
#
# Paste the ENTIRE contents of this file into the "User Data" field when
# creating a DigitalOcean droplet (Advanced Options → Add Initialization
# scripts). On first boot the droplet will, with no SSH:
#
#   * install Docker + the Compose plugin (skipped if already present, so
#     this works on both the Docker Marketplace image and vanilla Ubuntu)
#   * fetch Lurker and start it under Docker Compose
#   * optionally front it with Caddy for automatic HTTPS (Let's Encrypt)
#   * add a small swapfile on low-RAM droplets and configure the firewall
#
# Everything is logged to /var/log/lurker-deploy.log — view that from the
# DigitalOcean droplet console if a deploy doesn't come up as expected.
#
# ─── Edit these two values before pasting ───────────────────────────────────

# Public domain for an HTTPS deployment, e.g. "irc.example.com".
#   * Set it → Lurker is served over HTTPS via Caddy. The domain must
#              already have a DNS A/AAAA record pointing at this droplet.
#   * Empty  → Lurker is served over plain HTTP on port 8015.
LURKER_DOMAIN=""

# Let's Encrypt contact address (used only when LURKER_DOMAIN is set).
# Leave empty to default to admin@<LURKER_DOMAIN>.
ACME_EMAIL=""

# ─── No edits needed below this line ────────────────────────────────────────

set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/amiantos/lurker/main"
INSTALL_DIR="/opt/lurker"
DEPLOY_LOG="/var/log/lurker-deploy.log"

# cloud-init runs headless, so mirror all output into a log file that can be
# read back later from the droplet console.
exec > >(tee -a "$DEPLOY_LOG") 2>&1

log() { echo "[lurker-deploy $(date -u +%H:%M:%S)] $*"; }

log "=== Lurker deploy started $(date -u +%FT%TZ) ==="

# ── Prerequisites ───────────────────────────────────────────────────────────

ensure_curl() {
  if command -v curl >/dev/null 2>&1; then
    return
  fi
  log "Installing curl..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl ca-certificates
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker already installed ($(docker --version)) — skipping install."
    return
  fi
  log "Docker not found — installing via the official convenience script."
  export DEBIAN_FRONTEND=noninteractive
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
  systemctl enable --now docker
}

# On the Docker Marketplace image the daemon may still be settling when
# cloud-init runs; wait for it rather than assuming the socket is ready.
wait_for_docker() {
  log "Waiting for the Docker daemon..."
  local i
  for i in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      log "Docker daemon is ready."
      return
    fi
    sleep 2
  done
  log "ERROR: Docker daemon did not become ready within 60s."
  exit 1
}

# Prefer the Compose v2 plugin; fall back to the legacy v1 binary for older
# images. Every compose invocation below goes through this wrapper.
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    log "ERROR: no Docker Compose (v2 plugin or v1 binary) found."
    exit 1
  fi
}

# ── Host setup ──────────────────────────────────────────────────────────────

# The cheapest droplets ship 512MB–1GB of RAM; a small swapfile keeps the
# image pull and Node runtime comfortable.
ensure_swap() {
  local mem_kb
  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  if [ "$mem_kb" -ge 2000000 ]; then
    log "RAM is $((mem_kb / 1024))MB (>= 2GB) — no swapfile needed."
    return
  fi
  if swapon --show 2>/dev/null | grep -q .; then
    log "Swap already active — leaving it alone."
    return
  fi
  log "RAM is $((mem_kb / 1024))MB (< 2GB) — adding a 1GB swapfile."
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
}

# UFW: open SSH *first* so a bad rule can't lock us out, then the ports the
# chosen deployment mode actually needs.
#
# Note: Docker publishes container ports straight into iptables, bypassing
# UFW — so the real isolation of Lurker's 8015 in HTTPS mode comes from
# docker-compose.caddy.yml dropping its host port binding, not from the
# `ufw deny` below (kept only as belt-and-suspenders).
configure_firewall() {
  if ! command -v ufw >/dev/null 2>&1; then
    log "ufw not installed — skipping firewall configuration."
    return
  fi
  log "Configuring UFW firewall (SSH allowed first)..."
  ufw allow 22/tcp
  if [ -n "$LURKER_DOMAIN" ]; then
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw deny 8015/tcp
  else
    ufw allow 8015/tcp
  fi
  ufw --force enable
  ufw status verbose || true
}

# ── Deploy ──────────────────────────────────────────────────────────────────

deploy() {
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"

  log "Fetching docker-compose.yml..."
  curl -fsSL -o docker-compose.yml "$REPO_RAW/docker-compose.yml"

  if [ -n "$LURKER_DOMAIN" ]; then
    if [ -z "$ACME_EMAIL" ]; then
      ACME_EMAIL="admin@${LURKER_DOMAIN}"
    fi
    log "LURKER_DOMAIN is set ($LURKER_DOMAIN) — deploying with Caddy + HTTPS."
    curl -fsSL -o docker-compose.caddy.yml "$REPO_RAW/docker-compose.caddy.yml"
    curl -fsSL -o Caddyfile "$REPO_RAW/deploy/Caddyfile"

    # Compose interpolates these into docker-compose.caddy.yml, and Caddy
    # reads them from its container environment to fill the Caddyfile.
    cat > .env <<EOF
LURKER_DOMAIN=${LURKER_DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
EOF

    compose -f docker-compose.yml -f docker-compose.caddy.yml pull
    compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
    compose -f docker-compose.yml -f docker-compose.caddy.yml ps
  else
    log "LURKER_DOMAIN is empty — deploying plain HTTP on port 8015."
    compose pull
    compose up -d
    compose ps
  fi
}

# ── Run ─────────────────────────────────────────────────────────────────────

ensure_curl
install_docker
wait_for_docker
ensure_swap
deploy
configure_firewall

log "=== Lurker deploy finished $(date -u +%FT%TZ) ==="
if [ -n "$LURKER_DOMAIN" ]; then
  log "Open https://${LURKER_DOMAIN} — the first request can take ~60s while"
  log "Caddy obtains a Let's Encrypt certificate, then create your admin account."
  log "To enable passkeys / web push, see SELF_HOSTING.md (Optional features)."
else
  PUBLIC_IP=$(curl -fsS --max-time 5 \
    http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address \
    2>/dev/null || echo "<droplet-ip>")
  log "Open http://${PUBLIC_IP}:8015 and create your admin account."
fi
