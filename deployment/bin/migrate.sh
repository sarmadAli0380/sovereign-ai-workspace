#!/bin/sh
set -eu

secret_file=${DEPLOYMENT_DATABASE_PASSWORD_FILE:-/run/secrets/database_password}
database_host=${DEPLOYMENT_DATABASE_HOST:-database}
database_port=${DEPLOYMENT_DATABASE_PORT:-5432}
database_name=${DEPLOYMENT_DATABASE_NAME:-sovereign_ai}
database_user=${DEPLOYMENT_DATABASE_USER:-sovereign_app}

case "$database_host" in *[!a-z0-9-]*|'') echo "invalid database host" >&2; exit 64;; esac
case "$database_port" in *[!0-9]*|'') echo "invalid database port" >&2; exit 64;; esac
case "$database_name:$database_user" in *[!a-z0-9_:]*|'') echo "invalid database identity" >&2; exit 64;; esac
if [ ! -f "$secret_file" ] || [ -L "$secret_file" ]; then
  echo "database password secret must be a regular file" >&2
  exit 78
fi

database_password=$(cat "$secret_file")
case "$database_password" in *[!A-Za-z0-9._-]*|'') echo "database password uses an invalid deployment alphabet" >&2; exit 78;; esac
if [ "${#database_password}" -lt 32 ] || [ "${#database_password}" -gt 128 ]; then
  echo "database password must contain 32-128 characters" >&2
  exit 78
fi

umask 077
pgpass=/tmp/sovereign-pgpass
trap 'rm -f "$pgpass"' EXIT HUP INT TERM
printf '%s:%s:%s:%s:%s\n' "$database_host" "$database_port" "$database_name" "$database_user" "$database_password" > "$pgpass"
unset database_password
export PGPASSFILE=$pgpass
export DATABASE_URL="postgres://${database_user}@${database_host}:${database_port}/${database_name}?sslmode=disable"

/usr/local/bin/dbmate --migrations-dir /db/migrations --no-dump-schema up
/usr/local/bin/dbmate --migrations-dir /db/migrations --no-dump-schema status --exit-code
