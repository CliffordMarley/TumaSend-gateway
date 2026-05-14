#!/bin/sh
set -e

# ── Defaults (overridden by env_file / environment: in docker-compose.yml) ───
export KANNEL_ADMIN_PASSWORD="${KANNEL_ADMIN_PASSWORD:-changeme_admin}"
export KANNEL_STATUS_PASSWORD="${KANNEL_STATUS_PASSWORD:-changeme_status}"
export KANNEL_USERNAME="${KANNEL_USERNAME:-tumasend}"
export KANNEL_PASSWORD="${KANNEL_PASSWORD:-changeme_sms}"
# Docker Compose default bridge subnet — covers 172.16–172.31.x.x ranges
export KANNEL_TRUSTED_SUBNET="${KANNEL_TRUSTED_SUBNET:-172.*.*.*}"
export GATEWAY_HOST="${GATEWAY_HOST:-gateway}"
export GATEWAY_PORT="${GATEWAY_PORT:-3000}"

# ── Inject secrets into config ────────────────────────────────────────────────
envsubst < /etc/kannel/kannel.conf.template > /etc/kannel/kannel.conf

# ── Start bearerbox (SMSC connection manager) in background ──────────────────
bearerbox /etc/kannel/kannel.conf &
BEARERBOX_PID=$!

# Give bearerbox time to bind its ports before smsbox tries to connect
sleep 3

# ── Start smsbox (HTTP send API) in background ───────────────────────────────
smsbox /etc/kannel/kannel.conf &
SMSBOX_PID=$!

# ── Forward SIGTERM/SIGINT to both children so Docker stop is clean ──────────
trap "kill $BEARERBOX_PID $SMSBOX_PID 2>/dev/null; exit 0" TERM INT

# Block until one of the children exits (abnormal — restart policy handles it)
wait $BEARERBOX_PID $SMSBOX_PID
