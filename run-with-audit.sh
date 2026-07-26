#!/bin/bash

echo "╔════════════════════════════════════════════════════════╗"
echo "║    OpenHermit + Veilpiercer Audit (Phone Edition)      ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# Log session start
veilpiercer log "SESSION_START" "OpenHermit session initialized at $(date)"

# Run hermit chat
hermit chat

# Log session end
veilpiercer log "SESSION_END" "OpenHermit session completed"

echo ""
echo "Verifying audit integrity..."
veilpiercer verify

