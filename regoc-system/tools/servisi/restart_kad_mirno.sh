#!/bin/bash
# restart_kad_mirno.sh — restart RegocDaemona, TaskWebUI-ja i Klaudija TEK kad je sustav miran.
#
# Goranovo pravilo (06.09.2026.): restart je dopušten kad nema zadatka `in_progress`. Agent koji je
# popravak napravio ne može restartati sam (ubio bi vlastiti spawn), a REGOČ s Telegrama ne može
# restartati Klaudija (dijete je Klaudija) — zato odgođeni restart u zasebnom procesu (nova sesija).
#
# Mirno = 0 zadataka in_progress I nijedan `claude --print` (spawn) I nijedan `claude -p` (Klaudijeva
# sesija). Tada: globalna pauza (da daemon ne pokrene ništa usred restarta) → restart → pauza off →
# StaleCodeCheck → zadaci (ako su zadani) in_progress→completed → poruka u grupu REGOČ.
#
# Poziv:
#   setsid nohup restart_kad_mirno.sh [TASK-ID] [najdulje_sati=6] >/dev/null 2>&1 &
#   restart_kad_mirno.sh --stanje        izlaz 0 = jedan već čeka/restarta, 1 = nitko
#   restart_kad_mirno.sh --cekaj [s]     blokira dok ne završi onaj koji čeka (zadano 6 h); 0 = gotov
#
# Ulančani čekač NE SMIJE koristiti `pgrep -f restart_kad_mirno.sh`: to hvata svaki proces kojem se
# taj tekst nađe u argv-u (Telegram sesija čiji prompt spominje alat → čekalo se 2 h 46 min, TASK-5197).
# Koristi `--cekaj` / `--stanje`: oni gledaju isti flock kao i sam čekač.
#
# TASK-5197 (04.10.2026.) — tri kvara zbog kojih ovaj alat NIKAD nije restartao:
#  • spawnova() je vraćao "0\n0" (`pgrep -c` bez pogotka ispiše 0 I izađe s 1, pa je `|| echo 0`
#    dodao drugu nulu) → uvjet mirnoće nikad istinit → „rok istekao” 03.10. u 02:39 i 19:41,
#    iako je npr. 03.10. 17:03–18:31 bilo 0 zadataka in_progress.
#  • restartani servisi nasljeđivali su fd 8 (flock) → lock ostaje zauzet dok živi novi daemon.
#  • drugi pozivatelj je odustajao, a njegov zadatak nitko nije zatvorio → sad ide u red.
# TASK-5668 (Mac K1b, plan v3 P10 #7/#16) — alat je u kompletu i radi na Linuxu I macOS-u:
#  • brava je flock(2) iz perla (perl je ugrađen u oba OS-a; naredba za bravu je samo util-linux);
#    semantika ista: jezgra je pušta kad proces umre, restartani servisi je ne nasljeđuju (8>&-).
#  • TMPDIR novog daemona čita lib/platforma.ts (okolina procesa), ne izravno procfs.
#  • čvor BEZ glavnog regoc-services.sh (node-A, Mac): restart usluga RKM_USLUGE (zadano
#    regoc-daemon regoc-taskmanager) kroz platforma.restartUsluge — systemd korisnička jedinica |
#    sudo -n launchctl kickstart -k system/hr.regoc.<ime>. Klaudio postoji samo na glavnom stroju.
#  • rok naredbe kroz s_rokom (timeout | gtimeout | perl alarm), vrijeme bez GNU date.
# Ispit: ~/.claude/regoc/tests/restart-kad-mirno.test.ts
set -u
# TASK-5140: brana samorestarta u regoc-services.sh/manage.sh odbija restart kad je REGOC_TASK_ID
# u okolini (spawnani agent). Ovaj odgođeni put je upravo ono što brana preporučuje, pa identitet
# spawna ovdje briše — i da ga restartani daemon/Klaudio ne naslijede.
unset REGOC_TASK_ID REGOC_PROJECT_ID REGOC_AGENT_ID REGOC_TASK_DIR   # TASK-5414: i radna mapa spawna
# TASK-5338: restartani servisi (ploča, Klaudio, daemon kroz manage.sh) dobivaju TMPDIR izvan /tmp
# iz JEDNOG izvora — ne nasljeđuju mapu spawna koji je ovaj restart zakazao.
# shellcheck source=okolina-servisa.sh
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/okolina-servisa.sh" 2>/dev/null && okolina_servisa_izvezi
API="${RKM_API:-http://localhost:17781/api}"
SVC="$HOME/app/regoc_system/regoc-services.sh"
OVDJE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
PLAT="$OVDJE/../../lib/platforma.ts"    # komplet: ~/.claude/regoc/lib/platforma.ts
USLUGE="${RKM_USLUGE:-regoc-daemon regoc-taskmanager}"
if [ -f "$SVC" ]; then NACIN=svc; else NACIN=usluge; fi
DIR="$HOME/.tmp/regoc_logs"
LOG="$DIR/restart_kad_mirno.log"
LOCK="$DIR/restart_kad_mirno.lock"
RED="$DIR/restart_kad_mirno.red"        # zadaci koji čekaju ISTI restart (drugi pozivatelji)
SPAVAJ="${RKM_SPAVAJ:-30}"               # razmak provjera mirnoće (s)
RAZLOG_S="${RKM_RAZLOG_S:-600}"          # koliko često zapisati ZAŠTO još nije mirno (s)
mkdir -p "$DIR"
log() { echo "$(date +%Y-%m-%dT%H:%M:%S%z) $*" >> "$LOG"; }
# Epoha → čitljivo vrijeme bez GNU-ove opcije datuma iz epohe (BSD date je ne zna).
vrijeme_iz_epohe() { perl -MPOSIX -e 'print strftime("%Y-%m-%dT%H:%M:%S%z", localtime($ARGV[0]))' "$1"; }
# Rok naredbe: GNU timeout, coreutils gtimeout ili perl alarm (izlaz 124 kao GNU) — isto kao platforma.rokNaredba.
s_rokom() {
  local s="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$s" "$@"
  else perl -e 'my $s=shift; my $p=fork; if(!$p){exec @ARGV or exit 127} $SIG{ALRM}=sub{kill "TERM",$p; waitpid $p,0; exit 124}; alarm $s; waitpid $p,0; exit($?>>8)' "$s" "$@"
  fi
}
# Brava: flock(2) nad VEĆ otvorenim fd-om ljuske ($1), čekanje do $2 s (0 = ne čekaj). Brava pripada
# otvorenom opisu datoteke, pa ostaje dok ga ljuska drži, iako perl odmah izađe.
brava_fd() {
  perl -MFcntl=:flock -e 'open(my $f, ">&=", $ARGV[0]) or exit 2; my $do = time + $ARGV[1];
    until (flock($f, LOCK_EX | LOCK_NB)) { exit 1 if time >= $do; select(undef, undef, undef, 0.2) } exit 0' "$1" "$2"
}
# Je li brava slobodna / čekaj da se oslobodi (vlastiti fd 9 u podljusci; drži se samo trenutak).
brava_datoteka() { ( exec 9>>"$LOCK"; brava_fd 9 "$1" ); }
javi() {
  # TASK-5345 (ADR-0007 N1): bez `. spremište` — tg_send.py token čita iz ~/.claude/telegram.json
  ( python3 "$HOME/.claude/regoc/tools/telegram/tg_send.py" tekst --group regoc "$1" ) >> "$LOG" 2>&1
  log "javljeno: $1"
}

case "${1:-}" in
  --stanje) if brava_datoteka 0; then exit 1; else exit 0; fi ;;
  --cekaj)  brava_datoteka "${2:-21600}"; exit $? ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
esac

TASK="${1:-}"
MAX_S="${RKM_ROK_S:-$(( ${2:-6} * 3600 ))}"
ROK_DO="${RKM_ROK_DO:-$(( $(date +%s) + MAX_S ))}"   # apsolutni rok preživi ponovno pokretanje

# Stanje sustava → U_RADU (broj), U_RADU_ID (popis), SPAWNOVA (broj). Nepoznato = 99 (nije mirno).
stanje() {
  local o
  # Voditelj lanca (oznake voditelj-lanca + lanac:<x>, ADR-0024) je u načinu `on` stalno in_progress BEZ
  # procesa — ne broji se, inače bi restart čekao zauvijek (uputa #427, TASK-5678). Budan voditelj je
  # `claude --print` spawn, pa ga hvata SPAWNOVA ispod. Uvjet je i datoteka stanja koju piše daemon (ne samo oznake).
  o=$(curl -s -m 15 "$API/tasks?status=in_progress" | python3 -c 'import sys,json
d=json.load(sys.stdin); d=d.get("tasks",d) if isinstance(d,dict) else d
def oz(t):
    x=t.get("tags") or []
    if isinstance(x,str):
        try: x=json.loads(x)
        except Exception: x=[s.strip() for s in x.split(",")]
    return [str(s) for s in x] if isinstance(x,list) else []
import os,re
# Oznake sam postavlja tko god — voditelj je tek onaj kojem je daemon zapisao stanje (data/voditelji/<ID>.json).
mapa=os.path.join(os.environ.get("HOME",""),".claude","regoc","data","voditelji")
ima_stanje=lambda i: bool(re.fullmatch(r"[A-Za-z0-9_.-]+",i)) and os.path.isfile(os.path.join(mapa,i+".json"))
vod=lambda t: "voditelj-lanca" in oz(t) and any(s.startswith("lanac:") and len(s)>6 for s in oz(t)) and ima_stanje(str(t.get("id","")))
d=[t for t in d if not vod(t)]
print(len(d), ",".join(str(t.get("id","?")) for t in d)[:300] or "-")' 2>/dev/null)
  read -r U_RADU U_RADU_ID <<< "${o:-99 (API nedostupan)}"
  # `pgrep -c` bez pogotka ispiše „0” i izađe s 1 — NE dodavati `|| echo 0` (TASK-5197).
  SPAWNOVA=$(pgrep -fc '^claude (--print|-p) ' 2>/dev/null); SPAWNOVA="${SPAWNOVA:-99}"
}
mirno() { stanje; [ "$U_RADU" = 0 ] && [ "$SPAWNOVA" = 0 ]; }
opis_stanja() { echo "in_progress=$U_RADU (${U_RADU_ID:-}) spawnova=$SPAWNOVA"; }

exec 8>>"$LOCK"
if ! brava_fd 8 5; then
  if [ -n "$TASK" ]; then
    echo "$TASK" >> "$RED"
    # onaj koji čeka možda je upravo završio i red već pročitao → pokušaj preuzeti ulogu
    if ! brava_fd 8 0; then
      log "već čeka drugi restart_kad_mirno — $TASK upisan u red, zatvorit će ga on"; exit 0
    fi
    log "prethodni čekač je upravo završio — preuzimam red"
  else
    log "već čeka drugi restart_kad_mirno — izlazim"; exit 0
  fi
fi
log "start (zadatak=${TASK:-—}, rok do $(vrijeme_iz_epohe "$ROK_DO"), način: $([ "$NACIN" = svc ] && echo "regoc-services.sh" || echo "usluge ($USLUGE)"))"
zadnji_razlog=0
until mirno; do
  if [ "$(date +%s)" -gt "$ROK_DO" ]; then
    log "rok istekao — sustav nije bio miran: $(opis_stanja)"
    javi "⏳ Restart (${TASK:-—}) nije napravljen: sustav nije bio miran do roka ($(opis_stanja)). Treba ručno."
    exit 1
  fi
  if [ $(( $(date +%s) - zadnji_razlog )) -ge "$RAZLOG_S" ]; then
    log "čekam: $(opis_stanja)"; zadnji_razlog=$(date +%s)
  fi
  sleep "$SPAVAJ"
done
log "mirno — pauza i restart"
curl -s -X POST "$API/pause" -H 'Content-Type: application/json' \
  -d '{"paused":true,"by":"regoc","reason":"restart_kad_mirno: restart daemona, ploče i Klaudija"}' >> "$LOG" 2>&1
# utrka: spawn je mogao krenuti između provjere i pauze → ako jest, pusti i čekaj ponovno
sleep 2
if ! mirno; then
  curl -s -X POST "$API/pause" -H 'Content-Type: application/json' -d '{"paused":false,"by":"regoc","reason":"restart_kad_mirno: utrka, čekam"}' >> "$LOG" 2>&1
  log "utrka sa spawnom ($(opis_stanja)) — ponovno čekam"
  exec 8>&-
  RKM_ROK_DO="$ROK_DO" exec "$0" "$TASK"
fi
# Zadaci koje zatvara ovaj restart: vlastiti + svi iz reda (drugi pozivatelji dok smo čekali).
ZADACI=$( { [ -n "$TASK" ] && echo "$TASK"; cat "$RED" 2>/dev/null; } | grep -E '^TASK-[A-Za-z0-9]+$' | sort -u | tr '\n' ' ')
: > "$RED"
# 8>&- : restartani servisi NE smiju naslijediti lock (inače ga drži novi daemon dok živi).
if [ "$NACIN" = svc ]; then
  for s in daemon taskwebui klaudio; do
    s_rokom 110 "$SVC" restart-service "$s" >> "$LOG" 2>&1 8>&-
  done
else
  for u in $USLUGE; do
    if s_rokom 110 bun "$PLAT" restart-usluge "$u" >> "$LOG" 2>&1 8>&-; then log "restart $u: ok"
    else log "restart $u: NIJE uspio"; fi
  done
fi
sleep 3
curl -s -X POST "$API/pause" -H 'Content-Type: application/json' \
  -d '{"paused":false,"by":"regoc","reason":"restart_kad_mirno: gotovo"}' >> "$LOG" 2>&1
PID=$(cat "$HOME/.claude/regoc/daemon.pid" 2>/dev/null)
SVJEZE=$(s_rokom 60 bun "$HOME/.claude/regoc/StaleCodeCheck.ts" --entry "$HOME/.claude/regoc/RegocDaemon.ts" --pid "$PID" 2>&1 | tail -1)
log "StaleCodeCheck: $SVJEZE"
PLOCA=$(curl -s -o /dev/null -w '%{http_code}' "$API/status/dashboard")
KL=$(cat "$HOME/.tmp/regoc_pids/klaudio.pid" 2>/dev/null)
# TASK-5338: daemon iz keepera (`env -i`) nije imao TMPDIR → kritičar ENOSPC na /tmp (07.10., PID 463541).
# Restart koji novom daemonu ne da TMPDIR izvan /tmp nije isporuka — zadaci se tada ne zatvaraju.
DTMP=$(bun "$PLAT" okolina "$PID" TMPDIR 2>/dev/null)
log "TMPDIR daemona: ${DTMP:-(nema)} (okolina procesa $PID)"
OK=1; echo "$SVJEZE" | grep -q 'kod na disku == kod u pogonu' || OK=0; [ "$PLOCA" = 200 ] || OK=0
# Klaudio (Telegram) živi samo na glavnom stroju; čvor ima vlastiti poller u ploči paketa.
[ "$NACIN" = svc ] && { kill -0 "$KL" 2>/dev/null || OK=0; }
if [ "$NACIN" = svc ]; then OSTALI="ploče i Klaudija (PID $KL)"; OSTALI_KRATKO="Klaudio PID ${KL:-?}"
else OSTALI="usluga $USLUGE"; OSTALI_KRATKO="usluge $USLUGE"; fi
case "$DTMP" in ''|/tmp|/tmp/*) OK=0 ;; esac
if [ "$OK" = 1 ]; then
  # TASK-5210 (QA-5165 N3): alat NAMJERNO ne nosi daemonov token — restart nije dokaz agentova rada.
  # Pod `zatvaranjeKrozDaemonLive` ploča vraća 202 (`ceka-kriticara`), a zadatak zatvara daemon nakon
  # kritičara. To je uspješna predaja, ne zatvaranje, pa se tako i javlja.
  ZATVORENI=""; KRITICARU=""; NEUSPJELI=""
  ODG="$DIR/restart_kad_mirno.odg"
  for Z in $ZADACI; do
    curl -s -X PUT "$API/tasks/$Z" -H 'Content-Type: application/json' -d '{"status":"in_progress"}' >> "$LOG" 2>&1
    KOD=$(curl -s -o "$ODG" -w '%{http_code}' -X PUT "$API/tasks/$Z" -H 'Content-Type: application/json' \
      -d "{\"status\":\"completed\",\"resultSummary\":\"Isporuka u pogon: restart daemona (PID $PID), $OSTALI kad je sustav bio miran (restart_kad_mirno.sh, $(TZ=Europe/Zagreb date '+%d.%m.%Y. %H:%M')). StaleCodeCheck: kod na disku == kod u pogonu. TMPDIR daemona: $DTMP.\"}")
    { head -c 600 "$ODG" 2>/dev/null; echo; } >> "$LOG"
    case "$KOD" in
      200) log "$Z: zatvoren (200)"; ZATVORENI="$ZATVORENI $Z" ;;
      202) log "$Z: zatvaranje → 202 (predan kritičaru, oznaka ceka-kriticara — daemon zatvara kao completed ili blocked)"; KRITICARU="$KRITICARU $Z" ;;
      *)   log "$Z: NIJE zatvoren (HTTP $KOD)"; NEUSPJELI="$NEUSPJELI $Z" ;;
    esac
  done
  javi "🔄 Restart obavljen ($(TZ=Europe/Zagreb date '+%H:%M')): daemon PID $PID, ploča HTTP $PLOCA, $OSTALI_KRATKO — kod u pogonu je svjež.${ZATVORENI:+ Zatvoreni:$ZATVORENI.}${KRITICARU:+ Predani kritičaru:$KRITICARU.}${NEUSPJELI:+ NISU zatvoreni:$NEUSPJELI (vidi $LOG).}"
else
  log "provjera NIJE prošla — zadaci se ne zatvaraju"
  javi "⚠️ Restart (${ZADACI:-—}) napravljen, ali provjera NIJE prošla: ploča HTTP $PLOCA, $OSTALI_KRATKO, TMPDIR daemona: ${DTMP:-(nema)}, StaleCodeCheck: $SVJEZE. Log: $LOG"
fi
log "kraj (ok=$OK, zadaci=${ZADACI:-—})"
# Netko se upisao u red dok je restart trajao (nakon snimke reda) → novi krug za njega.
exec 8>&-
if [ -s "$RED" ]; then
  log "u redu su novi zadaci ($(tr '\n' ' ' < "$RED")) — novi krug"
  exec "$0" ""
fi
