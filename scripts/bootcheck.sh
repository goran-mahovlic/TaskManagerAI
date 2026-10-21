#!/usr/bin/env bash
# bootcheck.sh — provjera čvora nakon podizanja ili nadogradnje, Linux i macOS (plan Mac v3 K4).
#
#   bash scripts/bootcheck.sh [--json] [--strogo] [--cekaj SEK] [--usluga IME] [--paket DIR] [--bez-zapisa]
#
#   M1 vlasnik usluge (systemd --user / LaunchDaemon) · M2 radna mapa procesa = paket ·
#   M3 HTTP 200 vlastiti Host / 403 tuđi · M4 nema osirotjelih procesa na vratima ·
#   M5 AI servis prijavljen (bilo koji) i mjerilo autonomije · M6 sat (NTP) ·
#   M7 izvori memorije i RAG-a odgovaraju prekidačima (memorija.json) ·
#   M8 korisnik usluge nema neograničen sudo (NOPASSWD: ALL → upozorenje)
#
# Ništa ne pokreće i ništa ne popravlja. Učita postavke čvora istim redom kao usluga
# (scripts/s-okolinom.sh), pa pozove scripts/bootcheck.ts. Zapis ide u
# $TM_HOME/log/bootcheck/ (zadnji.txt, zadnji.json) — odatle ga čita REGOČ.
# Izlaz: 0 PASS (upozorenja ne obaraju, osim uz --strogo) · 1 FAIL · 2 pogrešna uporaba.
set -uo pipefail

case "${1:-}" in -h|--help) sed -n '2,16p' "$0"; exit 0 ;; esac

OVDJE="$(cd "$(dirname "$0")/.." && pwd)"
# --paket DIR: mjeri instalaciju u DIR (npr. bootcheck iz druge kopije) — i postavke se čitaju odande
PAKET="$OVDJE"; prev=""
for a in "$@"; do [ "$prev" = "--paket" ] && PAKET="$a"; prev="$a"; done
TM_HOME="${TM_HOME:-$HOME/.taskmanager}"
export TM_HOME
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

ucitaj() { [ -f "$1" ] || return 0; set -a; # shellcheck disable=SC1090
  . "$1"; set +a; }

# od najslabijeg prema najjačem: instanca profila, postavke uz paket (stariji čvorovi),
# pa ono što čita s-okolinom.sh (instalacija.env, postavke.env čvora)
ucitaj "$TM_HOME/config/profil.instanca.env"
ucitaj "$PAKET/config/postavke.env"
ucitaj "$TM_HOME/config/instalacija.env"
ucitaj "$TM_HOME/config/postavke.env"

command -v bun >/dev/null 2>&1 || { echo "bootcheck: bun nije pronađen (PATH=$PATH)" >&2; exit 1; }
cd "$OVDJE" || exit 1
exec bun scripts/bootcheck.ts "$@"
