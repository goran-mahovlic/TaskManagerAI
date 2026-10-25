#!/usr/bin/env bash
# s-okolinom.sh — pokreni naredbu usluge s postavkama čvora (i, po potrebi, tajnama).
#
#   s-okolinom.sh [--tajne] [--datoteka F]… [--cekaj URL [--rok SEK]] -- naredba [arg…]
#
# Zašto omotač (plan Mac v3 P10 #2, #6): launchd nema `EnvironmentFile=` ni poredak
# `After=`, a plist u /Library/LaunchDaemons je čitljiv svima, pa tajne u njemu ne smiju
# stajati. Isti omotač zove i systemd jedinica, pa usluga na oba OS-a dobiva istu okolinu:
#   1. $TM_HOME/config/instalacija.env (piše je install.sh), pa postavke.env čvora
#      (TM_PORT, TM_BIND, TM_ALLOWED_HOSTS, … — bez tajni; ima prednost),
#   2. svaka --datoteka redom (npr. hindsight.env),
#   3. uz --tajne spremište tajni ($TM_CREDENTIALS, zadano $TM_HOME/config/credentials.env),
#   4. uz --cekaj čeka da URL vrati 2xx (zadano do 60 s), pa tek onda `exec`.
# Datoteka koja ne postoji se preskače (usluga mora krenuti i na čvoru bez tajni).
set -uo pipefail

TM_HOME="${TM_HOME:-$HOME/.taskmanager}"
export TM_HOME
TAJNE=0
CEKAJ=""
ROK=60
DATOTEKE=()
while [ $# -gt 0 ]; do
  case "$1" in
    --tajne)    TAJNE=1 ;;
    --datoteka) DATOTEKE+=("$2"); shift ;;
    --cekaj)    CEKAJ="$2"; shift ;;
    --rok)      ROK="$2"; shift ;;
    --)         shift; break ;;
    -h|--help)  sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "s-okolinom: nepoznat argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ $# -gt 0 ] || { echo "s-okolinom: nedostaje naredba iza --" >&2; exit 2; }

ucitaj() { [ -f "$1" ] || return 0; set -a; # shellcheck disable=SC1090
  . "$1"; set +a; }

ucitaj "$TM_HOME/config/instalacija.env"   # piše je install.sh
ucitaj "$TM_HOME/config/postavke.env"      # lokalne postavke čvora — imaju prednost
for d in "${DATOTEKE[@]+"${DATOTEKE[@]}"}"; do ucitaj "$d"; done
[ "$TAJNE" = 1 ] && ucitaj "${TM_CREDENTIALS:-$TM_HOME/config/credentials.env}"
# TASK-5793: korijen paketa — daemon kompleta po njemu nalazi alate paketa (tools/odlucitelj.py).
TM_PAKET_DIR="${TM_PAKET_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
export TM_PAKET_DIR

if [ -n "$CEKAJ" ]; then
  kraj=$(( $(date +%s) + ROK ))
  until curl -fsS -m 3 -o /dev/null "$CEKAJ" 2>/dev/null; do
    [ "$(date +%s)" -ge "$kraj" ] && { echo "s-okolinom: $CEKAJ ne odgovara ni nakon ${ROK} s — krećem svejedno" >&2; break; }
    sleep 2
  done
fi

exec "$@"
