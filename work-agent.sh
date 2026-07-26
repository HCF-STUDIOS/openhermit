#!/bin/bash

echo "╔════════════════════════════════════════════════════════╗"
echo "║           OpenHermit Work Agent                        ║"
echo "║                                                        ║"
echo "║  Type commands to track work, generate invoices       ║"
echo "║  All work is tamper-proof logged                      ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

veilpiercer log "WORK_AGENT_START" "Work tracking session started"

while true; do
  read -p "Agent> " cmd

  case $cmd in
    help)
      echo ""
      echo "Commands:"
      echo "  time <task> - Start timing a task"
      echo "  stop - Stop current timer"
      echo "  bill - Generate invoice"
      echo "  tasks - Show all tasks"
      echo "  verify - Check audit trail"
      echo "  exit - End session"
      echo ""
      ;;
    
    time)
      read -p "Task name: " task
      START=$(date +%s)
      echo "$task" > .current_task
      echo "$START" > .task_start_time
      veilpiercer log "TASK_STARTED" "$task"
      echo "✓ Timing: $task"
      ;;
    
    stop)
      if [ ! -f .current_task ]; then
        echo "✗ No active task"
        continue
      fi
      TASK=$(cat .current_task)
      START=$(cat .task_start_time)
      END=$(date +%s)
      DURATION=$((END - START))
      MINS=$((DURATION / 60))
      
      echo "$TASK,$MINS,$(date)" >> work_tasks.csv
      veilpiercer log "TASK_COMPLETED" "$TASK - $MINS minutes"
      
      echo "✓ Completed: $TASK ($MINS minutes)"
      rm .current_task .task_start_time
      ;;
    
    tasks)
      echo ""
      if [ -f work_tasks.csv ]; then
        echo "Task,Minutes,Date"
        cat work_tasks.csv
      else
        echo "No tasks logged yet"
      fi
      echo ""
      ;;
    
    bill)
      if [ ! -f work_tasks.csv ]; then
        echo "No billable tasks yet"
        continue
      fi
      TOTAL_MINS=$(awk -F',' '{sum += $2} END {print sum}' work_tasks.csv)
      TOTAL_HOURS=$(echo "scale=2; $TOTAL_MINS / 60" | bc)
      RATE=75
      TOTAL=$(echo "scale=2; $TOTAL_HOURS * $RATE" | bc)
      
      echo ""
      echo "╔════════════════════════════════════════════════════════╗"
      echo "║                    INVOICE                            ║"
      echo "╠════════════════════════════════════════════════════════╣"
      echo "║ Date: $(date)                              ║"
      echo "║ Total Hours: $TOTAL_HOURS                                       ║"
      echo "║ Rate: \$$RATE/hour                                          ║"
      echo "║ TOTAL DUE: \$$TOTAL                                           ║"
      echo "╚════════════════════════════════════════════════════════╝"
      echo ""
      veilpiercer log "INVOICE_GENERATED" "Invoice: $TOTAL_HOURS hrs @ \$$RATE = \$$TOTAL"
      ;;
    
    verify)
      echo ""
      veilpiercer verify
      echo ""
      ;;
    
    exit)
      veilpiercer log "WORK_AGENT_END" "Work session ended"
      echo ""
      echo "✓ Session logged and verified"
      veilpiercer verify
      break
      ;;
    
    *)
      echo "Unknown command. Type 'help'"
      ;;
  esac
done
