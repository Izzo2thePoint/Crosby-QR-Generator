#!/usr/bin/env bash
# Crosby VW Label Studio launcher (macOS / Linux)
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed. Get the LTS build from https://nodejs.org and run this again."
  echo
  exit 1
fi

echo "Starting the Label Studio... your browser will open in a moment."
node tools/serve.mjs
