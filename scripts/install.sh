#!/usr/bin/env bash
# install.sh — jedna naredba koja postavi TaskManagerAI na čistom stroju.
#
# Goran, 04.09.2026.: „svakako moramo imati ZOD na nodovima, ali mislim da bi ga bilo
# idealno uključiti i u TaskManager da je on dio instalacije."
#
# Zašto skripta, a ne samo `bun install`: pri postavljanju na oba noda ispalo je da
# ovisnosti nisu bile ondje, da `zod` uopće nije postojao, a da `chromadb` živi u tuđoj
# mapi. Sve je to riješeno rukom i to se ne smije ponoviti — ovdje je isti postupak,
# provjeren i ponovljiv.
#
#   bash scripts/install.sh                 # puna instalacija (bun install)
#   bash scripts/install.sh --posudi        # ovisnosti se povezuju iz postojeće instalacije
#   bash scripts/install.sh --bez-baze      # ne diraj bazu (već postoji)
#
# `--posudi` je za strojeve s malo diska (naš node-A radi na 97 % popunjenosti): umjesto
# drugog primjerka paketa, `node_modules` postaje mapa simboličkih veza na već postojeće
# ovisnosti. `zod` se u tom slučaju ipak instalira jer ga tamošnja instalacija nema.
set -uo pipefail

KORIJEN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$KORIJEN" || exit 1

POSUDI=0
BEZ_BAZE=0
for a in "$@"; do
  case "$a" in
    --posudi)   POSUDI=1 ;;
    --bez-baze) BEZ_BAZE=1 ;;
    -h|--help)  sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "nepoznat argument: $a"; exit 2 ;;
  esac
done

echo "TaskManagerAI — instalacija u $KORIJEN"

# ── 1. Bun ────────────────────────────────────────────────────────────────────
export PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  echo "  bun nije pronađen — instaliram"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
  export PATH="$HOME/.bun/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || { echo "  GREŠKA: bun se nije instalirao"; exit 1; }
echo "  bun: $(bun --version)"

# ── 2. Ovisnosti ──────────────────────────────────────────────────────────────
# `zod` je obavezan, a strojevi na kojima ovo vrtimo često NEMAJU pristup npm registryju
# (izmjereno na oba noda: `registry.npmjs.org` → 000). Zato paket nosi vlastiti primjerak u
# `vendor/zod.tgz` i instalacija ide redom: registry → prilog → već postojeća instalacija na
# stroju. Prvi koji uspije prekida niz; ako ni jedan ne uspije, instalacija staje s greškom.
osiguraj_zod() {
  # Kratak rok: bez mreže `bun add` visi minutama i instalacija „stane" bez poruke
  # (viđeno na node-A: dnevnik zastane na „postavljam" i ne miče se).
  timeout 25 bun add zod >/dev/null 2>&1 && [ -d node_modules/zod ] && { echo "    izvor: npm"; return 0; }
  if [ -f vendor/zod.tgz ]; then
    mkdir -p node_modules
    tar xzf vendor/zod.tgz -C . 2>/dev/null && [ -d node_modules/zod ] && { echo "    izvor: vendor/zod.tgz"; return 0; }
  fi
  for izvor in "${IZVORI[@]}"; do
    [ -d "$izvor/zod" ] || continue
    cp -r "$izvor/zod" node_modules/zod 2>/dev/null && { echo "    izvor: $izvor"; return 0; }
  done
  return 1
}

IZVORI=("$HOME/.claude/regoc/TaskManagerMD/node_modules" "$HOME/.claude/node_modules")
if [ "$POSUDI" = "1" ]; then
  echo "  ovisnosti: povezujem iz postojećih instalacija"
  rm -f node_modules 2>/dev/null
  mkdir -p node_modules
  for izvor in "${IZVORI[@]}"; do
    [ -d "$izvor" ] || continue
    for p in "$izvor"/*; do
      b="$(basename "$p")"
      [ -e "node_modules/$b" ] || ln -sfn "$p" "node_modules/$b"
    done
  done
  # `zod` je obavezan i NE smije se posuđivati — nijedna od tih instalacija ga nema,
  # a bez njega poslužitelj pada na prvoj shemi (provjereno na oba noda 04.09.2026.).
  if [ ! -d node_modules/zod ] || [ -L node_modules/zod ]; then
    rm -rf node_modules/zod
    echo "  zod: postavljam (obavezan, ne posuđuje se)"
    osiguraj_zod
  fi
else
  echo "  ovisnosti: bun install"
  if ! bun install >/dev/null 2>&1; then
    echo "  bun install nije uspio (nema mreže?) — pokušavam iz priloga"
    osiguraj_zod || { echo "  GREŠKA: ovisnosti se nisu postavile"; exit 1; }
  fi
fi

for p in zod; do
  [ -d "node_modules/$p" ] || { echo "  GREŠKA: nedostaje obavezna ovisnost '$p'"; exit 1; }
done
echo "  ovisnosti u node_modules: $(ls node_modules 2>/dev/null | wc -l) (zod ✓$([ -d node_modules/chromadb ] && echo ', chromadb ✓' || echo ', chromadb —'))"

# ── 3. Baza ───────────────────────────────────────────────────────────────────
if [ "$BEZ_BAZE" = "0" ]; then
  BAZA="${TM_DB:-${TM_HOME:-$HOME/.taskmanager}/data/tasks.db}"
  if [ -f "$BAZA" ]; then
    echo "  baza: već postoji ($BAZA) — ne diram"
  else
    bun scripts/init-db.ts >/dev/null 2>&1 && echo "  baza: stvorena ($BAZA)" \
      || echo "  UPOZORENJE: baza nije stvorena, pokreni ručno: bun run init"
  fi
fi

# ── 4. Rječnici sučelja ───────────────────────────────────────────────────────
# TASK-4713 (prenesen u paket TASK-4719): kod zna doći bez `locales/` i `config/jezik.json`,
# a ploča se u tom slučaju uredno digne i `/health` vrati 200 — samo što u pregledniku nema
# izbornika jezika, nego goli ključevi. Provjera zato ide PRIJE nego instalacija javi „U REDU".
echo "  rječnici sučelja…"
if ! bun scripts/provjeri-rjecnike.ts; then
  echo "  GREŠKA: rječnici sučelja nisu na svom mjestu (locales/, config/jezik.json)"
  echo "         vrati ih iz gita ili prijenosom: bash scripts/uskladi_s_regocem.sh"
  exit 1
fi

# ── 5. Git kuke ───────────────────────────────────────────────────────────────
# `.git/hooks` nije dio `git clone`, pa kuka iz `.githooks/` ne vrijedi dok se klonu ne
# kaže gdje je. Bez ovoga vratar identiteta commita (TASK-4723) postoji, ali ne radi.
if [ -d .git ] && [ -d .githooks ]; then
  git config core.hooksPath .githooks && echo "  git kuke: core.hooksPath = .githooks"
fi

# ── 6. Provjera da se doista podiže ───────────────────────────────────────────
VRATA="${TM_PORT:-17781}"
echo "  provjera na vratima $VRATA…"
TM_PORT="$VRATA" nohup bun src/TaskWebUI.ts > /tmp/tmai_install.log 2>&1 &
PID=$!
sleep 7
ODG="$(curl -s -m 8 "http://localhost:$VRATA/health" 2>/dev/null)"
kill "$PID" 2>/dev/null
if [ -n "$ODG" ]; then
  echo "  U REDU: $ODG"
  echo
  echo "Pokretanje:  TM_PORT=$VRATA bun src/TaskWebUI.ts"
  echo "Ploča:       http://localhost:$VRATA"
else
  echo "  NIJE SE PODIGLO — zadnji redci dnevnika:"
  tail -8 /tmp/tmai_install.log
  exit 1
fi
