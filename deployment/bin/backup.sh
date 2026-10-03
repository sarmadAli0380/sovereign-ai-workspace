#!/bin/bash
set -Eeuo pipefail

secret_file=${DEPLOYMENT_DATABASE_PASSWORD_FILE:-/run/secrets/database_password}
database_host=${DEPLOYMENT_DATABASE_HOST:-database}
database_port=${DEPLOYMENT_DATABASE_PORT:-5432}
database_name=${DEPLOYMENT_DATABASE_NAME:-sovereign_ai}
database_user=${DEPLOYMENT_DATABASE_USER:-sovereign_app}
backup_root=${DEPLOYMENT_BACKUP_ROOT:-/backups}

[[ "$database_host" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || { echo "invalid database host" >&2; exit 64; }
[[ "$database_port" =~ ^[0-9]+$ ]] || { echo "invalid database port" >&2; exit 64; }
[[ "$database_name" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "invalid database name" >&2; exit 64; }
[[ "$database_user" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "invalid database user" >&2; exit 64; }
[[ "$backup_root" == /backups ]] || { echo "backup destination must be the dedicated /backups mount" >&2; exit 64; }
[[ -f "$secret_file" && ! -L "$secret_file" ]] || { echo "database password secret must be a regular file" >&2; exit 78; }

database_password=$(<"$secret_file")
[[ "$database_password" =~ ^[A-Za-z0-9._-]{32,128}$ ]] || { echo "database password has invalid deployment encoding" >&2; exit 78; }

umask 077
pgpass=/tmp/sovereign-pgpass
temporary=""
trap 'rm -f "$pgpass" "$temporary"' EXIT HUP INT TERM
printf '%s:%s:%s:%s:%s\n' "$database_host" "$database_port" "$database_name" "$database_user" "$database_password" > "$pgpass"
unset database_password
export PGPASSFILE=$pgpass

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$backup_root/sovereign-ai-$timestamp.dump"
temporary="$target.partial"
pg_dump --host "$database_host" --port "$database_port" --username "$database_user" \
  --dbname "$database_name" --format custom --file "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$target"
temporary=""
sha256sum "$target" > "$target.sha256"
chmod 600 "$target.sha256"
printf '{"status":"completed","format":"postgres-custom","file":"%s","checksum":"%s.sha256"}\n' \
  "$(basename "$target")" "$(basename "$target")"
