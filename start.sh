#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "🧠 Starting ZeroKrang..."
echo ""
if [ ! -f .env ]; then
  echo "❌ No .env file. Copy .env.example to .env and add your keys."
  exit 1
fi
node server.js
