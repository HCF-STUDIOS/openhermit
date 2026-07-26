#!/bin/bash
echo "╔════════════════════════════════════════════════════════╗"
echo "║    OpenHermit Phone Agent + Audit Logging             ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
veilpiercer log "AGENT_START" "Phone agent session started"
COUNT=0
while true; do
  read -p "You: " msg
  if [ "$msg" = "exit" ]; then
    veilpiercer log "AGENT_END" "Session ended - $COUNT messages"
    echo ""
    echo "✓ Verifying audit trail..."
    veilpiercer verify
    break
  fi
  if [ "$msg" = "verify" ]; then
    veilpiercer verify
    echo ""
    continue
  fi
  COUNT=$((COUNT + 1))
  sanitized=$(echo "$msg" | sed 's/"//g' | cut -c1-100)
  veilpiercer log "USER_MSG" "[$COUNT] $sanitized"
  responses=("Interesting!" "I see." "Got it." "Tell me more." "That makes sense." "Continue?" "Understood.")
  response=${responses[$((RANDOM % ${#responses[@]}))]}
  echo "Agent: $response"
  veilpiercer log "AGENT_RESPONSE" "Response #$COUNT"
  echo ""
done
