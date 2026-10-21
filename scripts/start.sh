#!/usr/bin/env bash
# start.sh — pokreni ploču s postavkama čvora iz `$TM_HOME/config/postavke.env`.
#
# Zašto skripta, a ne `bun src/TaskWebUI.ts`: postavke koje odlučuju hoće li ploča uopće biti
# dostupna izvana (`TM_ALLOWED_HOSTS`) lako se zaborave pri ručnom pokretanju. Kad se
# zaborave, ploča na LAN adresi vraća „Forbidden - Host not allowed" i izgleda kao kvar
# mreže, a nije. Ovdje se čitaju istim redom kao u usluzi (scripts/s-okolinom.sh) i ispisuju.
#
#   bash scripts/start.sh              # vrata iz postavki ili 17781
#   bash scripts/start.sh 17801        # izričita vrata
#   bash scripts/start.sh --stani      # zaustavi ploču na tim vratima
#
# Gasi SAMO ploču iz ovog paketa (radna mapa procesa = paket). Tuđi proces na vratima ostaje,
# a skripta izlazi s 3 (QA K6 B1: probna instalacija ugasila je živu ploču drugog sustava).
set -uo pipefail

KORIJEN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$KORIJEN" || exit 1
# ~/.local/bin: ondje žive `claude` i `glas` — ploča bez njega javlja „no Claude CLI" (TASK-5364).
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

# Postavke istim redom kao usluga (QA K6 B2): $TM_HOME/config/instalacija.env, pa postavke.env
# čvora. Stari položaj <paket>/config/postavke.env još se čita, ali PRIJE (čvorove ima prednost).
if [ -z "${TM_START_OKOLINA:-}" ]; then
  STARE="$KORIJEN/config/postavke.env"
  if [ -f "$STARE" ]; then
    echo "upozorenje: $STARE je stari položaj postavki — premjesti ih u ${TM_HOME:-$HOME/.taskmanager}/config/postavke.env" >&2
    # shellcheck disable=SC1090
    set -a; . "$STARE"; set +a
  fi
  TM_START_OKOLINA=1 exec bash "$KORIJEN/scripts/s-okolinom.sh" -- bash "$KORIJEN/scripts/start.sh" "$@"
fi
unset TM_START_OKOLINA

STANI=0
VRATA="${TM_PORT:-17781}"
for a in "$@"; do
  case "$a" in
    --stani) STANI=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *[0-9]*) VRATA="$a" ;;
  esac
done

DNEVNIK="${TM_LOG:-$HOME/taskmanager_$VRATA.log}"

# Proces se traži PO VRATIMA: `TM_PORT` je varijabla okoline i ne vidi se u `ps`, pa
# `pkill -f "TM_PORT=…"` promašuje (naučeno pri postavljanju na čvorove).
# Linux (`ss` ili procfs) i macOS (`lsof`) razlikuje platformni sloj (TASK-5654).
pid_na_vratima() {
  bun src/core/platforma.ts pid-na-vratima "$VRATA" 2>/dev/null
}

# radna mapa procesa = ovaj paket? (isto mjerilo kao install.sh k_provjera i deinstaliraj d_procesi)
mapa_procesa() { bun src/core/platforma.ts cwd "$1" 2>/dev/null; }
nasa_ploca() {
  local c; c="$(mapa_procesa "$1")"
  [ -n "$c" ] && [ "$(cd "$c" 2>/dev/null && pwd -P)" = "$KORIJEN" ]
}

STARI="$(pid_na_vratima)"
if [ -n "$STARI" ]; then
  if ! nasa_ploca "$STARI"; then
    echo "GREŠKA: vrata $VRATA drži proces koji nije ploča iz $KORIJEN — ne diram ga" >&2
    echo "  PID $STARI: $(ps -o args= -p "$STARI" 2>/dev/null | cut -c1-100)" >&2
    echo "  radna mapa: $(mapa_procesa "$STARI" || true)" >&2
    echo "  zaustavi ga sam ili odaberi druga vrata: bash scripts/start.sh <vrata> (ili TM_PORT u postavke.env)" >&2
    exit 3
  fi
  echo "zaustavljam ploču na vratima $VRATA (PID $STARI)"
  kill "$STARI" 2>/dev/null
  sleep 3
  [ -n "$(pid_na_vratima)" ] && { kill -9 "$STARI" 2>/dev/null; sleep 2; }
elif [ "$STANI" = "1" ]; then
  echo "nema ploče na vratima $VRATA"; exit 0
fi
[ "$STANI" = "1" ] && { echo "zaustavljeno"; exit 0; }

TM_PORT="$VRATA" nohup bun src/TaskWebUI.ts > "$DNEVNIK" 2>&1 &
NOVI=$!
sleep 7
ODG="$(curl -s -m 8 "http://localhost:$VRATA/health" 2>/dev/null)"
# odgovor mora dati NAŠ proces: vrata koja drži proces drugog korisnika (nevidljiv u ss/lsof)
# odgovorila bi i bez nas, a naša ploča bi pala na zauzetim vratima
if [ -n "$ODG" ] && ! kill -0 "$NOVI" 2>/dev/null; then
  echo "ploča se NIJE podigla — vrata $VRATA odgovaraju, ali ih drži drugi proces; zadnji redci dnevnika:"
  tail -8 "$DNEVNIK"
  exit 1
fi
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
