#!/usr/bin/env bash
# start.sh — pokreni ploču s postavkama iz `config/postavke.env`.
#
# Zašto skripta, a ne `bun src/TaskWebUI.ts`: postavke koje odlučuju hoće li ploča uopće biti
# dostupna izvana (`TM_ALLOWED_HOSTS`) lako se zaborave pri ručnom pokretanju. Kad se
# zaborave, ploča na LAN adresi vraća „Forbidden - Host not allowed" i izgleda kao kvar
# mreže, a nije. Ovdje se čitaju iz datoteke i ispisuju pri pokretanju.
#
#   bash scripts/start.sh              # vrata iz postavki ili 17781
#   bash scripts/start.sh 17801        # izričita vrata
#   bash scripts/start.sh --stani      # zaustavi ploču na tim vratima
set -uo pipefail

KORIJEN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$KORIJEN" || exit 1
export PATH="$HOME/.bun/bin:$PATH"

POSTAVKE="$KORIJEN/config/postavke.env"
# shellcheck disable=SC1090
[ -f "$POSTAVKE" ] && { set -a; . "$POSTAVKE"; set +a; }

STANI=0
VRATA="${TM_PORT:-17781}"
for a in "$@"; do
  case "$a" in
    --stani) STANI=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *[0-9]*) VRATA="$a" ;;
  esac
done

DNEVNIK="${TM_LOG:-$HOME/taskmanager_$VRATA.log}"

# Proces se traži PO VRATIMA: `TM_PORT` je varijabla okoline i ne vidi se u `ps`, pa
# `pkill -f "TM_PORT=…"` promašuje (naučeno pri postavljanju na čvorove).
pid_na_vratima() {
  ss -ltnp 2>/dev/null | awk -v p=":$VRATA" '$4 ~ p {print $NF}' \
    | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
}

STARI="$(pid_na_vratima)"
if [ -n "$STARI" ]; then
  echo "zaustavljam ploču na vratima $VRATA (PID $STARI)"
  kill "$STARI" 2>/dev/null
  sleep 3
  [ -n "$(pid_na_vratima)" ] && { kill -9 "$STARI" 2>/dev/null; sleep 2; }
fi
[ "$STANI" = "1" ] && { echo "zaustavljeno"; exit 0; }

TM_PORT="$VRATA" nohup bun src/TaskWebUI.ts > "$DNEVNIK" 2>&1 &
sleep 7
ODG="$(curl -s -m 8 "http://localhost:$VRATA/health" 2>/dev/null)"
if [ -n "$ODG" ]; then
  echo "ploča radi na vratima $VRATA"
  echo "  $ODG"
  echo "  dopušteni hostovi: ${TM_ALLOWED_HOSTS:-(samo localhost i vlastite adrese sučelja)}"
  echo "  dnevnik: $DNEVNIK"
else
  echo "ploča se NIJE podigla — zadnji redci dnevnika:"
  tail -8 "$DNEVNIK"
  exit 1
fi
