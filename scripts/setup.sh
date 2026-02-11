#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[setup] Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "node is required (>=22)"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required"; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "Node.js 22+ is required by @openai/agents. Current: $(node --version)"
  exit 1
fi

echo "[setup] Preparing local runtime directories..."
mkdir -p conversations

echo "[setup] Installing npm dependencies..."
npm install

cat <<EOF2

Setup complete.

Next:
  npm start

Open:
  http://127.0.0.1:8788/

Note:
  Set OPENAI_API_KEY before starting.
EOF2
