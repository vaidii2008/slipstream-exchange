#!/usr/bin/env bash
# Creates the cluster's one Secret from values generated here and sent straight to the cluster,
# so they are never written to a file or to git. k3s runs with --secrets-encryption, so the
# cluster stores them encrypted.
#
# Run once per cluster. It never replaces an existing Secret: Postgres keeps the password it
# first started with, and every bot account was registered with the bot password, so new
# values would lock the API out of its database and the bots out of their accounts.
set -euo pipefail

kube() { kubectl --context slipstream "$@"; }

kube apply -f "$(dirname "$0")/namespace.yaml"

if kube -n slipstream get secret slipstream >/dev/null 2>&1; then
  echo "secret slipstream already exists; leaving it as it is" >&2
  exit 0
fi

# Hex for the Postgres password, because it goes inside DATABASE_URL, where base64's
# "/" and "+" would need escaping. printf is a shell builtin, so no value appears in ps.
kube -n slipstream create secret generic slipstream --from-env-file=<(
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'JWT_ACCESS_SECRET=%s\n' "$(openssl rand -base64 48)"
  printf 'BOT_PASSWORD=%s\n' "$(openssl rand -hex 24)"
)
