#!/bin/sh
# ---------------------------------------------------------------------------
# n8n provisioning at startup: Postgres credential and workflow.
#
# Run by the `n8n-init` service once n8n is healthy. Idempotent: the import
# overwrites the existing entry by its ID, so restarting the stack does not
# create duplicates.
#
# The credential is written via `n8n import:credentials`, which encrypts it
# with N8N_ENCRYPTION_KEY. Writing directly to the database would mean
# reproducing that encryption by hand: fragile, and tied to the n8n version.
# ---------------------------------------------------------------------------
set -e

CRED_FILE=$(mktemp)
# Guaranteed cleanup: the file holds the password in plain text.
trap 'rm -f "$CRED_FILE"' EXIT INT TERM

cat > "$CRED_FILE" <<JSON
[
  {
    "id": "veille-db",
    "name": "Postgres — base veille",
    "type": "postgres",
    "data": {
      "host": "veille-db",
      "port": 5432,
      "database": "${VEILLE_DB}",
      "user": "${VEILLE_USER}",
      "password": "${VEILLE_PASSWORD}",
      "ssl": "disable",
      "allowUnauthorizedCerts": false,
      "maxConnections": 10
    }
  }
]
JSON

echo "→ Postgres credential"
n8n import:credentials --input="$CRED_FILE"

if [ -f /workflows/_import.json ]; then
  echo "→ monitoring workflow"
  n8n import:workflow --input=/workflows/_import.json
fi

echo "✓ provisioning complete"
