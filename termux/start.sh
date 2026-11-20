#!/data/data/com.termux/files/usr/bin/bash
# Start the Sideload local bridge inside Termux.
#
# Usage (in Termux, from this folder):
#   bash start.sh
#   SIDELOAD_PORT=8765 bash start.sh
#
# Then in the website choose "This phone (Termux)", set the same port and tap
# Connect. Wireless Debugging must be enabled in Developer options.

set -euo pipefail

if ! command -v pkg >/dev/null 2>&1; then
  echo "This script is meant to run inside Termux." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Installing Python..."
  pkg install -y python
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "Installing Android platform tools (adb)..."
  pkg install -y android-tools
fi

PORT="${SIDELOAD_PORT:-8765}"
HOST="${SIDELOAD_HOST:-127.0.0.1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Starting Sideload bridge on ws://${HOST}:${PORT}"
echo "Open the website and connect to port ${PORT}. Press Ctrl+C to stop."
exec python3 "${SCRIPT_DIR}/bridge.py" --host "${HOST}" --port "${PORT}"
