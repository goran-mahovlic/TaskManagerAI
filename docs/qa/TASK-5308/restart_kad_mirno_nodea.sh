#!/bin/bash
# TASK-5308: na node-A aktivira drop-in konzole (StandardOutput → ~/.tmp/regoc_logs/*.log) i
# TM_FEATURES_FILE ploče TEK kad je in_progress = 0 i nijedan agent (claude --print) ne radi
# (pravilo zadatka: restart na node-A samo uz in_progress = 0). Rok 48 h. Daemon se NE dira.
# POPRAVAK 07.10. 09:04 UTC: bez sidra `^` pgrep je brojao i vlastiti `bash -c` sesije ssh (naredba sadrži
# „claude --print"), pa stanje nikad nije bilo „0 0" i čekač nije okinuo. Restart je izveden ručno uz in_progress=0.
CILJ=regoc@192.168.10.20
LOG=/home/klaudio/app/tmp/TASK-5308/restart_kad_mirno_nodea.log
ROK=$(( $(date +%s) + 48*3600 ))
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 $CILJ"
echo "[$(date -Is)] start, čekam in_progress=0 na $CILJ" >> "$LOG"
while [ "$(date +%s)" -lt "$ROK" ]; do
  STANJE=$($SSH 'n=$(curl -s --max-time 10 "localhost:17781/api/tasks?status=in_progress" | python3 -c "import json,sys;d=json.load(sys.stdin);d=d if isinstance(d,list) else d.get(\"tasks\",[]);print(len(d))" 2>/dev/null); a=$(pgrep -fc "^claude "); echo "$n $a"' 2>/dev/null)
  if [ "$STANJE" = "0 0" ]; then
    echo "[$(date -Is)] in_progress=0, agenata 0 → daemon-reload + restart regoc-taskmanager regoc-voice" >> "$LOG"
    $SSH 'systemctl --user daemon-reload && systemctl --user restart regoc-taskmanager regoc-voice; sleep 15; echo "stanje: $(systemctl --user is-active regoc-taskmanager regoc-voice | tr "\n" " ") http=$(curl -s -o /dev/null -w "%{http_code}" localhost:17781/api/tasks) pid=$(systemctl --user show -p MainPID --value regoc-taskmanager)"; ls -la ~/.tmp/regoc_logs/' >> "$LOG" 2>&1
    echo "GOTOVO" >> "$LOG"
    exit 0
  fi
  sleep 120
done
echo "[$(date -Is)] ISTEKLO (48 h) — in_progress na node-A nije pao na 0" >> "$LOG"
exit 1
