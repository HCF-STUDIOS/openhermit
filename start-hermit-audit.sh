#!/bin/bash

set -e

echo "╔════════════════════════════════════════════════════════╗"
echo "║    OpenHermit + Veilpiercer (Phone Edition)            ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# Start gateway
echo "Starting OpenHermit gateway..."
npm run start:gateway > /tmp/gateway.log 2>&1 &
GATEWAY_PID=$!
echo "Gateway PID: $GATEWAY_PID"

# Wait for gateway to be ready
echo "Waiting for gateway..."
MAX_ATTEMPTS=20
for i in $(seq 1 $MAX_ATTEMPTS); do
    if curl -s http://127.0.0.1:4000/api/agents >/dev/null 2>&1; then
        echo "✓ Gateway ready!"
        veilpiercer log "GATEWAY_READY" "OpenHermit gateway initialized"
        break
    fi
    if [ $i -eq $MAX_ATTEMPTS ]; then
        echo "✗ Gateway failed to start after 20 attempts"
        veilpiercer log "GATEWAY_FAILED" "Gateway startup timeout"
        kill $GATEWAY_PID 2>/dev/null || true
        exit 1
    fi
    echo "  Attempt $i/$MAX_ATTEMPTS..."
    sleep 1
done

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║             Starting Hermit Chat                       ║"
echo "║                                                        ║"
echo "║  Type your messages naturally                         ║"
echo "║  All conversations logged to .veilpiercer.jsonl       ║"
echo "║  Type 'exit' to quit                                  ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# Log chat session start
veilpiercer log "CHAT_START" "Interactive chat session started"

# Run chat (will block until user exits)
hermit chat || true

# Log chat session end
veilpiercer log "CHAT_END" "Interactive chat session completed"

# Kill gateway
echo ""
echo "Stopping gateway..."
kill $GATEWAY_PID 2>/dev/null || true
sleep 1

# Verify integrity
echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║              Audit Integrity Check                    ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

veilpiercer verify

echo ""
echo "✓ All done!"

