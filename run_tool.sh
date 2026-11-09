#!/usr/bin/env bash
# Khởi chạy ứng dụng Imou Vision Tool

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "=========================================================="
echo "          IMOU VISION TOOL - DISCOVER · MANAGE · SECURE   "
echo "=========================================================="

python3 "$DIR/app.py"
