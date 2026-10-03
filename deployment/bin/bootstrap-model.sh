#!/bin/sh
set -eu

model_id=${DEPLOYMENT_MODEL_ID:-qwen3:4b}
expected_digest=${DEPLOYMENT_MODEL_DIGEST:-sha256:359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7}
expected_version=${DEPLOYMENT_OLLAMA_VERSION:-0.32.5}
expected_short=$(printf '%s' "${expected_digest#sha256:}" | cut -c1-12)

case "$model_id" in *[!A-Za-z0-9._:/-]*|'') echo "invalid model id" >&2; exit 64;; esac
case "$expected_digest" in sha256:????????????????????????????????????????????????????????????????) :;; *) echo "invalid model digest" >&2; exit 64;; esac
if ! ollama --version 2>&1 | grep -F "$expected_version" >/dev/null; then
  echo "Ollama bootstrap image does not match expected version $expected_version" >&2
  exit 70
fi

export OLLAMA_HOST=127.0.0.1:11434
ollama serve >/tmp/ollama-bootstrap.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT HUP INT TERM

attempt=0
until ollama list >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    tail -n 40 /tmp/ollama-bootstrap.log >&2 || true
    echo "Ollama bootstrap server did not become ready" >&2
    exit 70
  fi
  sleep 1
done

installed_id=$(ollama list | awk -v model="$model_id" 'NR > 1 && $1 == model { print $2; exit }')
if [ "$installed_id" = "$expected_short" ]; then
  echo "model $model_id already matches pinned digest $expected_digest"
  exit 0
fi

ollama pull "$model_id"
installed_id=$(ollama list | awk -v model="$model_id" 'NR > 1 && $1 == model { print $2; exit }')
if [ "$installed_id" != "$expected_short" ]; then
  echo "model $model_id resolved to ${installed_id:-missing}, expected $expected_short" >&2
  exit 65
fi
echo "model $model_id installed at pinned digest $expected_digest"
