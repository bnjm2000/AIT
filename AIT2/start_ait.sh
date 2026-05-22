#!/usr/bin/env bash

APP_DIR="/c/Users/AVECp/Documents/AIT/AIT2"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/ait_startup.log"

mkdir -p "$LOG_DIR"
cd "$APP_DIR" || exit 1

echo "========================================" >> "$LOG_FILE"
echo "Starting AVEC Inventory Tracker: $(date)" >> "$LOG_FILE"

# Use virtual environment if it exists
if [ -f "$APP_DIR/.venv/Scripts/activate" ]; then
    source "$APP_DIR/.venv/Scripts/activate"
fi

# App server settings
export HOST="0.0.0.0"
export PORT="5443"
export ENABLE_HTTPS="1"

# Start the Flask app
if command -v py >/dev/null 2>&1; then
    py -3 app.py >> "$LOG_FILE" 2>&1
else
    python app.py >> "$LOG_FILE" 2>&1
fi