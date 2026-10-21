#!/bin/bash
# TASK-5306 — E2E na GLAVNOM sustavu (dell-home): „prebaci sve" + simulirana potrošena Anthropic sesija.
# Simulacija 96 %: ≥ sessionBlock (95, Config) → vrata daemona zatvorena za Anthropic; < BLOCK_THRESHOLD CLI
# kuke (97) → vlasnikov Klaudio na Anthropicu se NE blokira i ne šalje poruke o blokadi.
# Prozor prebacivanja je što kraći: čeka slobodno mjesto, prebaci, T1 krene, odmah „vrati".
set -u
D=/home/klaudio/app/tmp/TASK-5306
OUT=$D/glavni; mkdir -p "$OUT"
API=http://localhost:17781
LOG=~/.claude/regoc/daemon.log
ts() { date -u +%H:%M:%S; }
novi() {
  curl -s -X POST $API/api/tasks -H 'Content-Type: application/json' -d "{\"title\":\"[PROBA TASK-5306] $1\",\"description\":\"Probni zadatak QA TASK-5306. Ne diraj datoteke i ne pokreći alate. Odgovori točno ovim retkom: PONG-$1 i zatim zadnji redak: REGOC-STATUS: DONE — PONG-$1 vraćen\",\"assignee\":\"potjeh\",\"priority\":1,\"tags\":[\"proba\"],\"projectId\":\"PRJ-048\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])'
}
stanje() { curl -s $API/api/tasks/$1 | python3 -c 'import json,sys;t=json.load(sys.stdin);print(t.get("status"), "|", (t.get("resultSummary") or "")[:160].replace("\n"," "))'; }
pospremi() { # sigurnosna mreža: simulacija ugašena, prekidač vraćen
  [ -n "${SIMPID:-}" ] && kill "$SIMPID" 2>/dev/null
  curl -s $API/api/models/svi | grep -q '"aktivno":true' && curl -s -X PUT $API/api/models/svi -H 'Content-Type: application/json' -d '{"model":"vrati"}' >/dev/null
}
trap pospremi EXIT
cekaj_start() { for i in $(seq 1 $(( $2 / 3 ))); do st=$(stanje "$1" | cut -d' ' -f1); [ "$st" != pending ] && { echo "$st"; return; }; sleep 3; done; echo pending; }
u_radu() { curl -s "$API/api/tasks?status=in_progress" | python3 -c 'import json,sys;d=json.load(sys.stdin);d=d if isinstance(d,list) else d.get("tasks",d);print(len(d))'; }

echo "[$(ts)] čekam slobodno mjesto (strop 3)…"
for i in $(seq 1 1800); do n=$(u_radu); [ "$n" -lt 3 ] && break; sleep 2; done
echo "[$(ts)] u radu: $(u_radu)"
LOGPOS=$(wc -l < $LOG)

echo "== 1. simulacija 96 %"
SIM_PCT=96 setsid nohup python3 $D/sim_snimka.py >/dev/null 2>&1 & SIMPID=$!
sleep 4; cat ~/.claude/regoc/data/session_usage.cache.json; echo

echo "== 2. prebaci sve → openrouter:z-ai/glm-5.2"
curl -s -w ' HTTP %{http_code}' -X PUT $API/api/models/svi -H 'Content-Type: application/json' -d '{"model":"openrouter:z-ai/glm-5.2","tko":"potjeh-TASK-5306"}'; echo
T1=$(novi G-A-openrouter-96); echo "T1=$T1"
echo "T1: $(cekaj_start $T1 90)"
echo "== 3. Klaudio K1 (prekidač=openrouter)"
OZNAKA=K1 timeout 200 bun $D/klaudio_proba.ts 2>&1 | grep REZULTAT | tee $OUT/K1.txt

echo "== 4. vrati"
curl -s -w ' HTTP %{http_code}' -X PUT $API/api/models/svi -H 'Content-Type: application/json' -d '{"model":"vrati"}'; echo
python3 - <<EOF
import json
a=json.load(open('$D/main-model-config.prije.json')); b=json.load(open('/home/klaudio/.claude/regoc/models/model-config.json'))
for k in ('defaults','agentOverrides','componentOverrides'): print(k, 'IDENTIČNO' if a.get(k)==b.get(k) else 'RAZLIKA')
print('_prebaciSvePrije' in b and 'SNIMKA OSTALA' or 'snimka uklonjena')
EOF
T2=$(novi G-B-anthropic-96); echo "T2=$T2"
echo "T2 nakon 45 s: $(cekaj_start $T2 45)"
echo "== 5. Klaudio K2 (vraćeno, Anthropic)"
OZNAKA=K2 timeout 200 bun $D/klaudio_proba.ts 2>&1 | grep REZULTAT | tee $OUT/K2.txt

echo "== 6. kraj simulacije → svježe mjerenje"
kill $SIMPID; sleep 1; python3 ~/.claude/regoc/tools/telemetrija/session_usage.py --quiet; cat ~/.claude/regoc/data/session_usage.cache.json; echo
echo "T2 nakon obnove (do 10 min, čeka i mjesto): $(cekaj_start $T2 600)"
for i in $(seq 1 40); do a=$(stanje $T1 | cut -d' ' -f1); b=$(stanje $T2 | cut -d' ' -f1); [ "$a" != in_progress ] && [ "$b" != in_progress ] && [ "$b" != pending ] && break; sleep 10; done
echo "T1: $(stanje $T1)"; echo "T2: $(stanje $T2)"
echo "== 7. daemon.log"
tail -n +$LOGPOS $LOG | grep -a -E "$T1|$T2|vrata po provideru|\[autonomy|MODEL-SVI|Auto-exec" | cut -c1-260 | tee $OUT/daemon_izvadak.log
grep -a -E "\"$T1\"|\"$T2\"" ~/.claude/regoc/data/run_log.jsonl | cut -c1-400
echo "T1=$T1 T2=$T2" > $OUT/ids.txt
