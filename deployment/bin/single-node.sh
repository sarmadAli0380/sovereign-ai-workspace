#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
cd "$repo_root"

export SOVEREIGN_UID=${SOVEREIGN_UID:-$(id -u)}
export SOVEREIGN_GID=${SOVEREIGN_GID:-$(id -g)}
compose="docker compose --file compose.yaml"

require_files() {
  for file in "$@"; do
    if [ ! -f "$file" ] || [ -L "$file" ]; then
      echo "missing regular secret file: $file (see deployment/secrets/README.md)" >&2
      exit 78
    fi
  done
}

require_runtime_secrets() {
  require_files deployment/secrets/database_password deployment/secrets/spool_key
}

require_server_secrets() {
  require_runtime_secrets
  require_files deployment/secrets/session_registry
}

up() {
  require_server_secrets
  $compose build server runtime-check volume-init migrate model-bootstrap
  $compose --profile bootstrap run --rm model-bootstrap
  $compose up -d --wait database inference
  $compose run --rm migrate
  $compose run --rm volume-init
  $compose run --rm --no-deps runtime-check
  $compose up -d --wait server
}

up_airgapped() {
  require_server_secrets
  $compose up -d --wait --no-build database inference
  $compose run --rm --no-deps migrate
  $compose run --rm --no-deps volume-init
  $compose run --rm --no-deps runtime-check
  $compose up -d --wait --no-build server
}

case "${1:-}" in
  up) up;;
  up-airgapped) up_airgapped;;
  verify) require_runtime_secrets; $compose run --rm runtime-check;;
  backup)
    require_files deployment/secrets/database_password
    mkdir -p deployment/backups
    chmod 700 deployment/backups
    $compose --profile ops run --rm backup
    ;;
  down) $compose down;;
  config) $compose config;;
  *)
    echo "usage: $0 {up|up-airgapped|verify|backup|down|config}" >&2
    exit 64
    ;;
esac
