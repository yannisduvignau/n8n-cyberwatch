#!/bin/sh
# ---------------------------------------------------------------------------
# Provisionnement de n8n au démarrage : credential Postgres et workflow.
#
# Exécuté par le service `n8n-init`, après que n8n soit sain. Idempotent :
# l'import écrase l'entrée existante par son id, donc relancer la stack ne
# crée pas de doublon.
#
# Le credential est écrit via `n8n import:credentials`, qui le chiffre avec
# N8N_ENCRYPTION_KEY. Écrire directement en base imposerait de reproduire ce
# chiffrement à la main : fragile, et dépendant de la version de n8n.
# ---------------------------------------------------------------------------
set -e

CRED_FILE=$(mktemp)
# Nettoyage garanti : le fichier contient le mot de passe en clair.
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

echo "→ credential Postgres"
n8n import:credentials --input="$CRED_FILE"

if [ -f /workflows/_import.json ]; then
  echo "→ workflow de veille"
  n8n import:workflow --input=/workflows/_import.json
fi

echo "✓ provisionnement terminé"
