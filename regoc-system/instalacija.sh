#!/usr/bin/env bash
# instalacija.sh — priprema kompleta nakon kopiranja iz regoc-system/ u ~/.claude/regoc (plan Mac v3 P11, TASK-5705).
#
#   bash instalacija.sh [--paket DIR] [--tm-home DIR] [--suho]
#
# Ugovor s TaskManagerAI `scripts/install.sh` (korak K2.14-komplet): zadnji redak je PROMIJENJENO
# ili ISTO; izlaz ≠ 0 = pad. Idempotentno: postojeće postavke i datoteke se NIKAD ne prepisuju
# (samo se dodaje ono što fali), pa drugo pokretanje javlja ISTO.
#
# Radi:
#   1. config.primjer/*.json → config/ (samo one kojih nema), features.example.json → features.json,
#      models/model-config.example.json → models/model-config.json;
#   2. poveznice iz POVEZNICE.tsv: moduli koje kod uvozi izvan ~/.claude/regoc (../skills, ../VoiceServer,
#      kuka SecurityValidator, mjerilo session_usage.py) — samo ako na tom mjestu nema ničega;
#   3. ~/.claude/settings.json iz settings.json.primjer (kuka SecurityValidator) — samo ako ga nema;
#   4. uz --tm-home: credentials.env → $TM_HOME/config/credentials.env (spremište tajni paketa);
#   5. uz --tm-home: data/regoc.db → $TM_HOME/data/tasks.db (baza ploče paketa; komplet je čita kao regoc.db);
#   6. messages.db: tablice iz schema.sql ako ih nema (daemon ih sam ne stvara).
# Sve stvoreno izvan kompleta javlja se u $TM_KOMPLET_STVORENO (put|vrsta) — paket to stavlja u manifest.
set -euo pipefail

K="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PAKET=""; TM_HOME=""; SUHO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --paket) PAKET="${2:-}"; shift ;;
    --tm-home) TM_HOME="${2:-}"; shift ;;
    --suho) SUHO=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "nepoznat argument: $1" >&2; exit 2 ;;
  esac
  shift
done
: "${PAKET:=}" "${TM_HOME:=}"
CL="$HOME/.claude"
PROMJENA=0
javi() { printf '%s\n' "$*"; }
promijeni() { PROMJENA=1; if [ "$SUHO" = 1 ]; then javi "(suho) $1"; return 1; fi; javi "$1"; return 0; }
# Što stvorimo IZVAN kompleta javljamo paketu (TM_KOMPLET_STVORENO, redak `put|vrsta`): ide u manifest
# instalacije, pa ga `install.sh --do-nule` briše. Za mapu se javlja NAJVIŠA koju smo sami stvorili.
zapamti() { [ -n "${TM_KOMPLET_STVORENO:-}" ] && printf '%s|%s\n' "$1" "$2" >> "$TM_KOMPLET_STVORENO"; return 0; }
mapa_za() {  # mkdir -p, uz zapis najviše mape koja prije nije postojala
  local m="$1" vrh=""
  while [ ! -e "$m" ]; do vrh="$m"; m="$(dirname "$m")"; done
  mkdir -p "$1"; [ -n "$vrh" ] && zapamti "$vrh" mapa
  return 0
}

# 1. postavke iz primjera (cp -n)
mkdir_ako() { [ -d "$1" ] || { promijeni "mapa $1" && mkdir -p "$1"; } || true; }
mkdir_ako "$K/config"; mkdir_ako "$K/data"; mkdir_ako "$K/models"
kopiraj_ako() {  # izvor odrediste
  [ -e "$2" ] && return 0
  promijeni "postavka ${2#$K/} ← ${1#$K/}" && cp "$1" "$2" || true
}
if [ -d "$K/config.primjer" ]; then
  for c in "$K"/config.primjer/*.json; do [ -e "$c" ] && kopiraj_ako "$c" "$K/config/$(basename "$c")"; done
fi
[ -f "$K/features.example.json" ] && kopiraj_ako "$K/features.example.json" "$K/features.json"
[ -f "$K/models/model-config.example.json" ] && kopiraj_ako "$K/models/model-config.example.json" "$K/models/model-config.json"

# 2. poveznice izvan kompleta (POVEZNICE.tsv: <putanja u HOME>\t<putanja u kompletu>)
if [ -f "$K/POVEZNICE.tsv" ]; then
  while IFS=$'\t' read -r gdje cilj; do
    case "$gdje" in ''|'#'*) continue ;; esac
    g="$HOME/$gdje"; c="$K/$cilj"
    [ -e "$c" ] || { echo "GREŠKA: $cilj ne postoji u kompletu" >&2; exit 5; }
    if [ -L "$g" ]; then
      [ "$(readlink "$g")" = "$c" ] || javi "ostavljam $gdje (poveznica na drugo mjesto: $(readlink "$g"))"
      continue
    fi
    if [ -e "$g" ]; then javi "ostavljam $gdje (već postoji, nije poveznica)"; continue; fi
    promijeni "poveznica ~/$gdje → $cilj" && { mapa_za "$(dirname "$g")"; ln -s "$c" "$g"; zapamti "$g" veza; } || true
  done < "$K/POVEZNICE.tsv"
fi

# 3. settings.json s kukom SecurityValidator (samo ako ga nema — tuđi settings.json se ne dira)
if [ -f "$K/settings.json.primjer" ] && [ ! -e "$CL/settings.json" ]; then
  BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
  if promijeni "~/.claude/settings.json ← settings.json.primjer (kuka SecurityValidator)"; then
    mapa_za "$CL"
    sed -e "s|__HOME__|$HOME|g" -e "s|__BUN__|$BUN|g" "$K/settings.json.primjer" > "$CL/settings.json"
    zapamti "$CL/settings.json" datoteka
  fi
fi

# 4. spremište tajni (TASK-5705, uputa #441): komplet čita ~/.claude/regoc/credentials.env
#    (lib/spremiste-tajni.ts); uz paket je to poveznica na spremište paketa $TM_HOME/config/credentials.env,
#    u koje vlasnik upisuje tajne na ploči (Config → Tajne). Datoteka spremišta se NE stvara (stvara je
#    pisač ploče pri prvom upisu) — poveznica smije visjeti. Postojeće spremište kompleta se ne dira.
if [ -n "$TM_HOME" ]; then
  SPR="$TM_HOME/config/credentials.env"
  if [ -L "$K/credentials.env" ]; then
    [ "$(readlink "$K/credentials.env")" = "$SPR" ] || javi "ostavljam credentials.env (poveznica na drugo mjesto: $(readlink "$K/credentials.env"))"
  elif [ -e "$K/credentials.env" ]; then
    javi "ostavljam credentials.env (vlastito spremište kompleta, nije poveznica na spremište paketa)"
  else
    promijeni "poveznica credentials.env → $SPR (spremište tajni paketa)" && ln -s "$SPR" "$K/credentials.env" || true
  fi
fi

# 5. baza ploče (TASK-5662, Mac krug 3): komplet ploču čita iz ~/.claude/regoc/data/regoc.db
#    (TaskManagerSQL, postavke autonomije i stropa, AgentSelection…), a paket je drži u
#    $TM_HOME/data/tasks.db. Bez poveznice daemon čita nepostojeću bazu („unable to open database
#    file") i pragovi ostaju zadani. SQLite prati poveznicu, pa -wal/-shm idu uz pravu bazu.
#    Postojeća baza kompleta (čvor koji je već imao vlastitu regoc.db) se ne dira.
if [ -n "$TM_HOME" ]; then
  BAZA="$TM_HOME/data/tasks.db"
  if [ -L "$K/data/regoc.db" ]; then
    [ "$(readlink "$K/data/regoc.db")" = "$BAZA" ] || javi "ostavljam data/regoc.db (poveznica na drugo mjesto: $(readlink "$K/data/regoc.db"))"
  elif [ -e "$K/data/regoc.db" ]; then
    javi "ostavljam data/regoc.db (vlastita baza kompleta, nije poveznica na bazu paketa)"
  else
    promijeni "poveznica data/regoc.db → $BAZA (baza ploče paketa)" && { mkdir -p "$K/data"; ln -s "$BAZA" "$K/data/regoc.db"; } || true
  fi
fi

# 6. red poruka (TASK-5662, Mac krug 3): RegocDaemon otvara messages.db izravno (getDb) i schema.sql
#    nikad ne pokreće — na svježem čvoru glavna petlja svake sekunde pada na „no such table: messages".
#    Tablice se stvaraju jednom (CREATE … IF NOT EXISTS); postojeća baza s tablicom messages se ne dira.
if [ -f "$K/schema.sql" ]; then
  BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
  ima="$("$BUN" -e 'const { Database } = require("bun:sqlite"); const fs = require("fs"); const p = process.argv[1];
    if (!fs.existsSync(p)) { console.log(0); process.exit(0) }
    const db = new Database(p, { readonly: true });
    console.log(db.query("select count(*) n from sqlite_master where type=\x27table\x27 and name=\x27messages\x27").get().n)' "$K/messages.db" 2>/dev/null || echo greska)"
  case "$ima" in
    1) ;;
    0) promijeni "messages.db ← schema.sql (tablice reda poruka)" && "$BUN" -e 'const { Database } = require("bun:sqlite");
         const db = new Database(process.argv[1]); db.exec(require("fs").readFileSync(process.argv[2], "utf-8")); db.close()' \
         "$K/messages.db" "$K/schema.sql" || true ;;
    *) echo "GREŠKA: messages.db se ne može pročitati ($K/messages.db)" >&2; exit 5 ;;
  esac
fi

[ -n "$PAKET" ] && javi "paket: $PAKET"
[ -n "$TM_HOME" ] && javi "tm-home: $TM_HOME"
if [ "$PROMJENA" = 1 ]; then echo PROMIJENJENO; else echo ISTO; fi
