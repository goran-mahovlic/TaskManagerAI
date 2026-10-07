#!/bin/bash
# TASK-5306 — E2E na node-A: „prebaci sve" + simulirana potrošena Anthropic sesija + povratak na Claude.
# Pokreće se s glavnog stroja; sve se izvodi na regoc@192.168.10.20 nad pogonom (daemon + ploča).
set -u
N=regoc@192.168.10.20
OUT=/home/klaudio/app/tmp/TASK-5306/nodea
mkdir -p "$OUT"
S() { ssh -o BatchMode=yes "$N" "export PATH=\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH; $1"; }
API=http://127.0.0.1:17781
ts() { date -u +%H:%M:%S; }
LOGPOS=$(S 'wc -l < ~/.claude/regoc/daemon.log')
echo "[$(ts)] početak, daemon.log redak $LOGPOS"

novi() { # $1 oznaka → id zadatka
  S "curl -s -X POST $API/api/tasks -H 'Content-Type: application/json' -d '{\"title\":\"[PROBA TASK-5306] $1\",\"description\":\"Probni zadatak QA TASK-5306. Ne diraj datoteke i ne pokreći alate. Odgovori točno ovim retkom: PONG-$1 i zatim zadnji redak: REGOC-STATUS: DONE — PONG-$1 vraćen\",\"assignee\":\"potjeh\",\"priority\":1,\"tags\":[\"proba\"]}'" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])'
}
stanje() { S "curl -s $API/api/tasks/$1" | python3 -c 'import json,sys;t=json.load(sys.stdin);print(t.get("status"), "|", (t.get("resultSummary") or "")[:160].replace("\n"," "))'; }
cekaj_start() { # $1 id, $2 s → vrati status
  for i in $(seq 1 $(( $2 / 5 ))); do st=$(stanje "$1" | cut -d' ' -f1); [ "$st" != pending ] && { echo "$st"; return; }; sleep 5; done; echo pending
}
logod() { S "tail -n +$LOGPOS ~/.claude/regoc/daemon.log | grep -a -E '$1' | cut -c1-260"; }

echo "== 0. početno stanje"
S "curl -s $API/api/models/svi; echo; tail -n1 ~/.claude/regoc/data/session_usage.jsonl; python3 -c 'import json;print(\"autonomyGate\",json.load(open(\"/home/regoc/.claude/regoc/features.json\"))[\"autonomyGate\"][\"enabled\"])'"

echo "== 1. simulirana snimka 99 % (≥ sessionBlock 90)"
SIMPID=$(S 'setsid nohup python3 ~/.tmp/TASK-5306/sim_snimka.py >/dev/null 2>&1 & echo $!')
echo "sim PID $SIMPID"; sleep 4
S "cat ~/.claude/regoc/data/session_usage.cache.json"; echo

echo "== 2. prebaci sve → openrouter:z-ai/glm-5.2 (isti PUT kao gumb na Config stranici)"
S "curl -s -w ' HTTP %{http_code}' -X PUT $API/api/models/svi -H 'Content-Type: application/json' -d '{\"model\":\"openrouter:z-ai/glm-5.2\",\"tko\":\"potjeh-TASK-5306\"}'"; echo
S "curl -s $API/api/models/svi; echo; python3 -c 'import json;m=json.load(open(\"/home/regoc/.claude/regoc/models/model-config.json\"));print(\"defaults\",m[\"defaults\"]);print(\"potjeh\",m[\"agentOverrides\"][\"potjeh\"],\"razgovor\",m[\"agentOverrides\"].get(\"razgovor\"),\"embeddings\",m[\"componentOverrides\"][\"embeddings\"],\"classifier\",m[\"componentOverrides\"][\"classifier\"])'"
echo "-- 2b. loš unos mora dati 400"
S "curl -s -w ' HTTP %{http_code}' -X PUT $API/api/models/svi -H 'Content-Type: application/json' -d '{\"model\":\"nepostoji:xyz\"}'"; echo
T1=$(novi A-openrouter-99); echo "T1=$T1 (prekidač=openrouter, sesija 99 %)"
echo "T1 status nakon čekanja: $(cekaj_start $T1 120)"

echo "== 3. razgovor R1 (prekidač=openrouter, sesija 99 %) — mora odgovoriti GLM, kvota se ne pita"
S "cd ~/TaskManagerAI && set -a && . config/postavke.env && set +a && unset TM_RAZGOVOR_PUNO && OZNAKA=R1 timeout 200 bun ~/.tmp/TASK-5306/razgovor_proba.ts 2>&1 | grep REZULTAT" | tee "$OUT/R1.txt"

echo "== 4. vrati na konfiguraciju (Claude)"
S "curl -s -w ' HTTP %{http_code}' -X PUT $API/api/models/svi -H 'Content-Type: application/json' -d '{\"model\":\"vrati\"}'"; echo
S "python3 - <<'EOF'
import json
a=json.load(open('/home/regoc/.tmp/TASK-5306/model-config.prije.json')); b=json.load(open('/home/regoc/.claude/regoc/models/model-config.json'))
for k in ('defaults','agentOverrides','componentOverrides'): print(k, 'IDENTIČNO' if a.get(k)==b.get(k) else 'RAZLIKA')
print('snimka _prebaciSvePrije', '_prebaciSvePrije' in b)
EOF"
T2=$(novi B-anthropic-99); echo "T2=$T2 (prekidač vraćen → anthropic:opus, sesija 99 %)"
echo "T2 status nakon 60 s: $(cekaj_start $T2 60)"

echo "== 5. razgovor R2 (Claude, sesija 99 %) — mora vratiti poruku kvote, 0 poziva modela"
S "cd ~/TaskManagerAI && set -a && . config/postavke.env && set +a && unset TM_RAZGOVOR_PUNO && OZNAKA=R2 timeout 200 bun ~/.tmp/TASK-5306/razgovor_proba.ts 2>&1 | grep REZULTAT" | tee "$OUT/R2.txt"

echo "== 6. kraj simulacije → svježe stvarno mjerenje"
S "kill $SIMPID; sleep 1; python3 ~/app/regoc_system/tools/session_usage.py --quiet; cat ~/.claude/regoc/data/session_usage.cache.json"; echo
echo "T2 status nakon obnove (do 120 s): $(cekaj_start $T2 120)"

echo "== 7. razgovor R3 (Claude, stvarna sesija) — mora odgovoriti Anthropic model"
S "cd ~/TaskManagerAI && set -a && . config/postavke.env && set +a && unset TM_RAZGOVOR_PUNO && OZNAKA=R3 timeout 200 bun ~/.tmp/TASK-5306/razgovor_proba.ts 2>&1 | grep REZULTAT" | tee "$OUT/R3.txt"

echo "== 8. čekam završetak T1/T2"
for i in $(seq 1 36); do a=$(stanje $T1 | cut -d' ' -f1); b=$(stanje $T2 | cut -d' ' -f1); [ "$a" != in_progress ] && [ "$b" != in_progress ] && [ "$b" != pending ] && break; sleep 10; done
echo "T1: $(stanje $T1)"; echo "T2: $(stanje $T2)"
echo "== 9. daemon.log (od početka probe)"
logod "$T1|$T2|vrata po provideru|autonomy|MODEL-SVI|Auto-exec" | tee "$OUT/daemon_izvadak.log"
echo "T1=$T1 T2=$T2" > "$OUT/ids.txt"
