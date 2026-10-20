#!/usr/bin/env bash
# install.sh — jedan ulaz za instalaciju TaskManagerAI na Debian/Ubuntu i macOS.
#
#   bash scripts/install.sh                          # ploča na ovom stroju (bez usluge)
#   bash scripts/install.sh --cvor IME [--profil upravitelj-cvora] [--baze] [--komplet]
#   bash scripts/install.sh --suho …                 # samo ispiše što bi napravila, ništa ne piše
#
# Opcije:
#   --cvor IME          instanca čvora: $TM_HOME/config/postavke.env (0600), usluga ploče,
#                       TM_BIND = 127.0.0.1 + adresa tailneta (nikad 0.0.0.0 na tuđoj mreži)
#   --bind POPIS        izričit TM_BIND (zarezom), npr. 127.0.0.1,100.64.0.7
#   --profil IME        kopira profili/IME/instanca.primjer.env u $TM_HOME/config/profil.instanca.env
#   --baze              lokalni pgvector (RAG, 127.0.0.1:15433) + Hindsight (127.0.0.1:17796),
#                       instalirani i ZAUSTAVLJENI dok ih prekidač ne uključi (plan P5)
#   --komplet           komplet izvornog sustava (RegocDaemon…) iz config/komplet.lock (plan P11)
#   --komplet-commit SHA  drugi commit kompleta od onog u lock datoteci (petlja popravka)
#   --claude            instaliraj Claude CLI i bez --komplet
#   --suho              ništa ne piše ni ne instalira; ispisuje korake i tablicu preduvjeta
#   --bez-servisa       bez systemd/launchd usluga (provjera ploče ide privremenim procesom)
#   --bez-baze          ne diraj bazu zadataka
#   --posudi            node_modules kao veze na postojeću instalaciju (malo diska)
#   --preskoci K[,K]    preskoči korake po imenu (npr. pdf,baze-modeli); bilježi se u logu
#   --log-dir DIR       roditelj mape loga (zadano $TM_HOME/log/install)
#   --dopusti-prljavo   dopusti instancu čvora iz radnog stabla s lokalnim izmjenama
#
# Log (plan Mac v3 P3.1): $TM_HOME/log/install/<vrijeme>/{koraci.jsonl,install.log,okolina.txt,
# install-rezultat.json}, `zadnji` pokazuje na zadnji krug. Svaki korak prvo mjeri pa tek onda
# piše, pa drugo pokretanje javlja „0 promjena".
# Piše se za bash 3.2 (macOS /bin/bash): bez asocijativnih polja, a prazno polje se širi samo
# uz zaštitu ("${a[@]+"${a[@]}"}"), jer ga `set -u` u 3.2 smatra nepostavljenim.
# Izlaz: 0 uspjeh · 2 pogrešna uporaba · 3 preduvjet · 4 mreža · 5 ovisnosti · 6 baza ·
#        7 usluga · 8 provjera nakon podizanja · 130 prekinuto.
set -uo pipefail
export LC_NUMERIC=C   # decimalna točka u trajanju koraka (hr_HR bi dao zarez → neispravan JSON)

PAKET="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$PAKET" || exit 1
# shellcheck source=scripts/instalacija/zapis.sh
. "$PAKET/scripts/instalacija/zapis.sh"

HINDSIGHT_VERZIJA="0.10.2"
PG0_VERZIJA="0.15.2"
PYTHON_BAZE="3.13"

ARGUMENTI="$*"
CVOR=""; BIND=""; PROFIL=""; BAZE=0; KOMPLET=0; KOMPLET_COMMIT=""; CLAUDE=0; SUHO=0
BEZ_SERVISA=0; BEZ_BAZE=0; POSUDI=0; PRESKOCI=","; LOG_DIR_ARG=""; DOPUSTI_PRLJAVO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cvor)            CVOR="${2:-}"; shift ;;
    --bind)            BIND="${2:-}"; shift ;;
    --profil)          PROFIL="${2:-}"; shift ;;
    --baze)            BAZE=1 ;;
    --komplet)         KOMPLET=1 ;;
    --komplet-commit)  KOMPLET_COMMIT="${2:-}"; KOMPLET=1; shift ;;
    --claude)          CLAUDE=1 ;;
    --suho)            SUHO=1 ;;
    --bez-servisa)     BEZ_SERVISA=1 ;;
    --bez-baze)        BEZ_BAZE=1 ;;
    --posudi)          POSUDI=1 ;;
    --preskoci)        PRESKOCI="$PRESKOCI${2:-},"; shift ;;
    --log-dir)         LOG_DIR_ARG="${2:-}"; shift ;;
    --dopusti-prljavo) DOPUSTI_PRLJAVO=1 ;;
    -h|--help)         sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "nepoznat argument: $1 (pomoć: bash scripts/install.sh --help)" >&2; exit 2 ;;
  esac
  shift
done
if [ -n "$CVOR" ] && ! printf '%s' "$CVOR" | grep -Eq '^[a-z0-9][a-z0-9-]{0,62}$'; then
  echo "--cvor: ime smije imati mala slova, brojke i '-' (do 63 znaka)" >&2; exit 2
fi
if [ -n "$PROFIL" ] && [ ! -d "$PAKET/profili/$PROFIL" ]; then
  echo "--profil: nema profila '$PROFIL' (postoje: $(ls "$PAKET/profili" | tr '\n' ' '))" >&2; exit 2
fi
if [ -n "$KOMPLET_COMMIT" ] && ! printf '%s' "$KOMPLET_COMMIT" | grep -Eq '^[0-9a-f]{7,40}$'; then
  echo "--komplet-commit: očekujem git sha (7–40 heksadecimalnih znakova)" >&2; exit 2
fi

TM_HOME="${TM_HOME:-$HOME/.taskmanager}"
export TM_HOME
TM_PORT="${TM_PORT:-17781}"
# Odredište kompleta: TM_KOMPLET_DIR ili polje `odrediste` iz config/komplet.lock (relativno
# prema $HOME) — paket sam ne zna raspored mapa izvornog sustava (ADR-0001 O1.4).
KOMPLET_DIR="${TM_KOMPLET_DIR:-}"
if [ "$KOMPLET" = 1 ] && [ -z "$KOMPLET_DIR" ] && [ -f "$PAKET/config/komplet.lock" ] && command -v python3 >/dev/null 2>&1; then
  KOMPLET_DIR="$(python3 -c 'import json,os,sys; o=json.load(open(sys.argv[1])).get("odrediste") or ""; print(os.path.join(os.environ["HOME"], o) if o and not o.startswith("/") else o)' "$PAKET/config/komplet.lock" 2>/dev/null)"
fi
BAZE_VENV="$TM_HOME/baze/venv"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

N_PROMIJENJENO=0; N_PRESKOCENO=0; N_KORAKA=0
TRENUTNI_KORAK=""; ZAVRSENO=0
MANIFEST_NOVO=()        # put|vrsta|korak — upisuje se u $TM_HOME/instalirano.json na kraju
UPOZORENJA=()

# ── okvir koraka ──────────────────────────────────────────────────────────────
# Korak je funkcija koja prvo mjeri; kad nešto mijenja, zove `promjena`, a kad ne treba
# ništa, `razlog "…"`. Vraća 0 ili kod iz zaglavlja. Uz SUHO=1 funkcija ne smije pisati.
promjena() { KORAK_PROMJENA=1; }
razlog()   { KORAK_RAZLOG="$*"; }
naredba()  { KORAK_NAREDBA="$*"; }
upozori()  { KORAK_UPOZORENJE="$*"; UPOZORENJA+=("$TRENUTNI_KORAK: $*"); }
u_manifest() { MANIFEST_NOVO+=("$1|$2|$TRENUTNI_KORAK"); }
suho() { [ "$SUHO" = 1 ]; }
# radi <opis> -- naredba…: uz --suho samo ispiše, inače izvrši
radi() {
  local opis="$1"; shift; [ "${1:-}" = "--" ] && shift
  if suho; then echo "    (suho) $opis"; return 0; fi
  echo "    ▶ $opis"
  "$@"
}

korak() {
  local id="$1" opis="$2" fn="$3" kat="${4:-5}"
  TRENUTNI_KORAK="$id"; KORAK_PROMJENA=0; KORAK_RAZLOG=""; KORAK_NAREDBA=""; KORAK_UPOZORENJE=""
  N_KORAKA=$((N_KORAKA + 1))
  local ime="${id#K2.*-}"
  case "$PRESKOCI" in *",$ime,"*|*",$id,"*)
    zapis_log "── $id  $opis — preskočeno (--preskoci)"
    zapis_korak "$id" "$opis" "" 0 0 false "izričito preskočen (--preskoci $ime)" ""
    N_PRESKOCENO=$((N_PRESKOCENO + 1)); return 0 ;;
  esac
  zapis_log "── $id  $opis"
  local t0 kod izlaz_tekst rep
  t0="$(sad_s)"
  if suho; then
    # bez cijevi: funkcija mora raditi u ovoj ljusci (OS, PATH, brojači), a ništa se ne piše
    "$fn" 2>&1; kod=$?; rep=""
  else
    local out="$LOG_DIR/.korak.out"
    "$fn" > "$out" 2>&1; kod=$?
    izlaz_tekst="$(zatamni < "$out")"
    [ -n "$izlaz_tekst" ] && zapis_log "$(printf '%s\n' "$izlaz_tekst" | sed 's/^/  /')"
    rep="$(printf '%s\n' "$izlaz_tekst" | tail -20)"
    rm -f "$out"
  fi
  local traj; traj="$(razlika_s "$t0" "$(sad_s)")"
  local prom=false; [ "$KORAK_PROMJENA" = 1 ] && prom=true
  # neočekivan kod (1, 124 isteka roka…) → kod kategorije koraka iz zaglavlja
  if [ "$kod" != 0 ] && { [ "$kod" -lt 3 ] || [ "$kod" -gt 8 ]; }; then kod="$kat"; fi
  zapis_korak "$id" "$opis" "$KORAK_NAREDBA" "$kod" "$traj" "$prom" "$KORAK_RAZLOG" "$rep" "$KORAK_UPOZORENJE"
  if [ "$kod" != 0 ]; then
    zapis_log "  ✗ $id pao (izlaz $kod)"
    PAD_PORUKA="$(printf '%s\n' "$rep" | grep -v '^[[:space:]]*$' | tail -1)"
    ZAVRSENO=1
    zapis_rezultat "pad" "$id" "$kod" "${PAD_PORUKA:-korak $id nije uspio}"
    [ -n "${LOG_DIR:-}" ] && echo "log: $LOG_DIR"
    exit "$kod"
  fi
  if [ "$KORAK_PROMJENA" = 1 ]; then N_PROMIJENJENO=$((N_PROMIJENJENO + 1)); zapis_log "  ✓ promijenjeno"
  else N_PRESKOCENO=$((N_PRESKOCENO + 1)); zapis_log "  ✓ ${KORAK_RAZLOG:-bez promjene}"; fi
}

na_kraju() {
  local kod=$?
  [ "$ZAVRSENO" = 1 ] && return
  ZAVRSENO=1
  zapis_rezultat "pad" "${TRENUTNI_KORAK:-pocetak}" "$([ "$kod" = 0 ] && echo 1 || echo "$kod")" "instalacija je izašla izvan koraka (izlaz $kod)"
}
na_prekid() {
  ZAVRSENO=1
  zapis_rezultat "prekinuto" "${TRENUTNI_KORAK:-pocetak}" 130 "prekinuto signalom $1"
  echo; echo "prekinuto ($1) — log: ${LOG_DIR:-—}"; exit 130
}
trap na_kraju EXIT
trap 'na_prekid INT' INT
trap 'na_prekid TERM' TERM

# s_rokom SEK naredba… — GNU timeout ili perl alarm (macOS), izlaz 124 pri isteku
s_rokom() {
  local sek="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$sek" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$sek" "$@"
  else perl -e 'my $s=shift; my $p=fork; if(!$p){exec @ARGV or exit 127} $SIG{ALRM}=sub{kill "TERM",$p; waitpid $p,0; exit 124}; alarm $s; waitpid $p,0; exit($?>>8)' "$sek" "$@"
  fi
}
# dohvati URL DATOTEKA — 3 pokušaja (5/15/45 s), rok 120 s po pokušaju; izlaz 4 bez mreže
dohvati() {
  local url="$1" cilj="$2" i
  for i in 1 2 3; do
    s_rokom 120 curl -fsSL --retry 0 -o "$cilj" "$url" && return 0
    [ "$i" = 3 ] && break
    echo "    dohvat $url nije uspio (pokušaj $i/3) — čekam"; sleep $(( i == 1 ? 5 : i == 2 ? 15 : 45 ))
  done
  echo "    GREŠKA: $url nije dostupan nakon 3 pokušaja"; return 4
}
# pokreni_skriptu URL [arg…] — službena instalacijska skripta (bun, Claude CLI, uv): prvo
# preuzimanje u datoteku (provjeriv izlaz curla), pa izvršavanje; nikad cijev ravno u ljusku.
pokreni_skriptu() {
  local url="$1"; shift
  local f="$TM_HOME/tmp/instalacija-$$.sh"
  mkdir -p "$TM_HOME/tmp"
  dohvati "$url" "$f" || { rm -f "$f"; return 4; }
  bash "$f" "$@"; local k=$?
  rm -f "$f"; return $k
}
isti_sadrzaj() { [ -f "$2" ] && cmp -s "$1" "$2"; }
pisi_ako_razlicito() {   # pisi_ako_razlicito IZVOR CILJ MOD — 0 bez promjene, 10 zapisano
  local izvor="$1" cilj="$2" mod="${3:-644}"
  if isti_sadrzaj "$izvor" "$cilj"; then
    [ "$(stat_mod "$cilj")" = "$mod" ] && return 0
    suho || chmod "$mod" "$cilj"; return 10
  fi
  suho && return 10
  mkdir -p "$(dirname "$cilj")"
  if [ -e "$cilj" ]; then mkdir -p "$BACKUP_DIR"; cp -p "$cilj" "$BACKUP_DIR/$(basename "$cilj")"; fi
  cp "$izvor" "$cilj" && chmod "$mod" "$cilj"; return 10
}
# pisi_sadrzaj SADRZAJ CILJ MOD — isto kao gore, ali bez privremene datoteke (--suho ne piše ništa)
pisi_sadrzaj() {
  local sadrzaj="$1" cilj="$2" mod="${3:-644}"
  if [ -f "$cilj" ] && [ "$(cat "$cilj")" = "$sadrzaj" ]; then
    [ "$(stat_mod "$cilj")" = "$mod" ] && return 0
    suho || chmod "$mod" "$cilj"; return 10
  fi
  suho && return 10
  mkdir -p "$(dirname "$cilj")"
  if [ -e "$cilj" ]; then mkdir -p "$BACKUP_DIR"; cp -p "$cilj" "$BACKUP_DIR/$(basename "$cilj")"; fi
  printf '%s\n' "$sadrzaj" > "$cilj" && chmod "$mod" "$cilj"; return 10
}
# bez_buna — uz --suho na stroju bez buna (svjež Mac) korak samo javi da ga provjerava kasnije
bez_buna() {
  command -v bun >/dev/null 2>&1 && return 1
  suho || return 1
  echo "    (suho) bun još ne postoji — ovaj korak ide nakon instalacije buna"; promjena; return 0
}
stat_mod() { python3 -c 'import os, sys; print(format(os.stat(sys.argv[1]).st_mode & 0o777, "o"))' "$1"; }

# ═════════════════════════════════════════════════════════════════════════════
# KORACI
# ═════════════════════════════════════════════════════════════════════════════

k_os() {
  local s="${TM_INSTALL_OS:-$(uname -s)}"
  case "$s" in
    Linux|linux)
      OS=linux
      if [ -f /etc/os-release ]; then
        # shellcheck disable=SC1091
        OS_OPIS="$(. /etc/os-release; echo "${PRETTY_NAME:-Linux}") $(uname -m)"
        case "$(. /etc/os-release; echo "${ID:-} ${ID_LIKE:-}")" in
          *debian*|*ubuntu*) ;;
          *) echo "    upozorenje: provjereno samo na Debianu/Ubuntuu"; upozori "distribucija nije Debian/Ubuntu" ;;
        esac
      else OS_OPIS="Linux $(uname -m)"; fi ;;
    Darwin|darwin)
      OS=darwin
      local v; v="$(sw_vers -productVersion 2>/dev/null || echo "${TM_INSTALL_MACOS:-0}")"
      OS_OPIS="macOS $v $(uname -m)"
      if [ -z "${TM_INSTALL_OS:-}" ] && [ "${v%%.*}" -lt 14 ] 2>/dev/null; then
        echo "    GREŠKA: potreban je macOS 14 ili noviji (ovdje $v)"; return 3
      fi ;;
    *) OS_OPIS="$s"; echo "    GREŠKA: podržani su Debian/Ubuntu i macOS ≥ 14, a ovo je $s"; return 3 ;;
  esac
  echo "    $OS_OPIS"
  razlog "otkriveno: $OS_OPIS"
}

k_stablo() {
  [ -d "$PAKET/.git" ] || { razlog "nije git stablo (instalacija iz arhive)"; return 0; }
  local lokalno=()
  for f in config/postavke.env config/memorija.json config/credentials.env .env; do
    [ -e "$PAKET/$f" ] && lokalno+=("$f")
  done
  local prljavo; prljavo="$(git -C "$PAKET" status --porcelain --untracked-files=no 2>/dev/null)"
  if [ -n "$CVOR" ] && [ "$DOPUSTI_PRLJAVO" = 0 ]; then
    if [ "${#lokalno[@]}" -gt 0 ]; then
      echo "    GREŠKA: lokalne postavke u stablu paketa: ${lokalno[*]}"
      echo "    Instanca čvora drži ih SAMO u $TM_HOME/config (plan P4.1). Premjesti ih ondje i ponovi."
      return 3
    fi
    if [ -n "$prljavo" ]; then
      echo "    GREŠKA: radno stablo ima lokalne izmjene (git status):"; printf '%s\n' "$prljavo" | head -10 | sed 's/^/      /'
      echo "    Čvor se instalira iz čistog klona; za razvoj: --dopusti-prljavo"
      return 3
    fi
  elif [ -n "$prljavo" ] || [ "${#lokalno[@]}" -gt 0 ]; then
    upozori "radno stablo nije čisto"; echo "    upozorenje: radno stablo ima lokalne izmjene ili postavke$([ "${#lokalno[@]}" -gt 0 ] && echo " (${lokalno[*]})")"
  fi
  razlog "git $(git -C "$PAKET" rev-parse --short HEAD 2>/dev/null)$([ -n "$prljavo" ] && echo ' (izmjene)' || echo ', čisto')"
}

brew_korisnikov() { command -v brew >/dev/null 2>&1 && [ -w "$(brew --prefix 2>/dev/null)" ]; }

k_preduvjeti() {
  local fali=() a
  for a in git curl; do command -v "$a" >/dev/null 2>&1 || fali+=("$a"); done
  [ "$OS" = darwin ] && { command -v perl >/dev/null 2>&1 || fali+=("perl"); }
  if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then fali+=("python3"); fi
  if [ "$OS" = linux ]; then
    { command -v bun >/dev/null 2>&1 || command -v unzip >/dev/null 2>&1; } || fali+=("unzip")
    [ -e /etc/ssl/certs/ca-certificates.crt ] || fali+=("ca-certificates")
  fi
  echo "    obavezno: git curl python3≥3.9$([ "$OS" = linux ] && echo ' unzip ca-certificates' || echo ' perl')"
  local slobodno; slobodno="$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print int($4/1024)}')"
  echo "    disk: ${slobodno:-?} MiB slobodno (treba ≥ 2048$([ "$BAZE" = 1 ] && echo ', uz --baze ≥ 8192'))"
  local treba=2048; [ "$BAZE" = 1 ] && treba=8192
  [ -n "$slobodno" ] && [ "$slobodno" -lt "$treba" ] && fali+=("disk≥${treba}MiB")
  local roditelj="$TM_HOME"; while [ ! -e "$roditelj" ]; do roditelj="$(dirname "$roditelj")"; done
  [ -w "$roditelj" ] || fali+=("pisanje u $roditelj")
  if [ "$OS" = darwin ]; then
    if xcode-select -p >/dev/null 2>&1; then echo "    ✓ Command Line Tools ($(xcode-select -p 2>/dev/null))"
    else fali+=("Command Line Tools (xcode-select --install)"); fi
    # LaunchDaemon (korisnik bez GUI sesije nema LaunchAgent) traži root samo za launchctl/install
    if [ -n "$CVOR" ] && [ "$BEZ_SERVISA" = 0 ]; then
      if sudo -n true 2>/dev/null; then echo "    ✓ sudo bez lozinke (LaunchDaemon)"
      else
        fali+=("sudo bez lozinke za LaunchDaemon")
        # Ne predlaže se sudoers: tko smije upisati LaunchDaemon, može pokrenuti bilo što kao root.
        echo "    za usluge (LaunchDaemon) treba administratorsko pravo: pokreni 'sudo -v' (lozinka), pa ponovi"
        echo "    ili instaliraj bez usluga: --bez-servisa"
      fi
    fi
    if brew_korisnikov; then echo "    Homebrew: tvoj ($(brew --prefix)) — alternativa B dostupna"
    elif command -v brew >/dev/null 2>&1 || [ -d /opt/homebrew ]; then echo "    Homebrew: postoji, ali nije tvoj — ne diram ga (izvor B preskačem)"
    else echo "    Homebrew: nema — nije potreban"; fi
    echo "    macOS zamjene za Linux ovisnosti (plan P10):"
    printf '    %-3s %-34s %-48s %-3s %s\n' "#" "Linux" "macOS" "iz" "stanje"
    local br lin mac izv prov nap st
    while IFS=$'\t' read -r br lin mac izv prov nap; do
      case "$br" in ''|\#*) continue ;; esac
      if [ "$izv" = N ]; then st="nije podržano"
      elif [ "$prov" = "-" ]; then st="—"
      elif PAKET="$PAKET" bash -c "$prov" >/dev/null 2>&1; then st="✓"
      else st="✗ (${nap})"; fi
      printf '    %-3s %-34.34s %-48.48s %-3s %s\n' "$br" "$lin" "$mac" "$izv" "$st"
    done < "$PAKET/scripts/instalacija/preduvjeti-macos.tsv"
  fi
  if [ "${#fali[@]}" -gt 0 ]; then
    echo "    GREŠKA: nedostaje: ${fali[*]}"
    if [ "$OS" = linux ]; then
      local apt=(); for a in "${fali[@]}"; do case "$a" in git|curl|unzip|ca-certificates) apt+=("$a") ;; python3) apt+=(python3 python3-venv) ;; esac; done
      [ "${#apt[@]}" -gt 0 ] && echo "    instaliraj (root): sudo apt-get install -y ${apt[*]}"
    fi
    return 3
  fi
  razlog "sve obavezno postoji"
}

k_bun() {
  if command -v bun >/dev/null 2>&1; then razlog "već postoji: bun $(bun --version) ($(command -v bun))"; return 0; fi
  naredba "curl -fsSL https://bun.sh/install | bash"
  if suho; then echo "    (suho) instalirala bih bun u $HOME/.bun"; promjena; return 0; fi
  pokreni_skriptu https://bun.sh/install || return 4
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || { echo "    GREŠKA: bun se nije instalirao"; return 5; }
  echo "    bun $(bun --version)"
  u_manifest "$HOME/.bun" mapa; promjena
}

zig_ovisnosti() { cat "$PAKET/package.json" "$PAKET/bun.lock" 2>/dev/null | (shasum -a 256 2>/dev/null || sha256sum) | cut -c1-64; }

osiguraj_zod() {
  if [ "${TM_BEZ_MREZE:-0}" != 1 ]; then
    s_rokom 25 bun add zod >/dev/null 2>&1 && [ -d node_modules/zod ] && { echo "    zod: npm"; return 0; }
  fi
  if [ -f vendor/zod.tgz ]; then
    mkdir -p node_modules
    tar xzf vendor/zod.tgz -C . 2>/dev/null && [ -d node_modules/zod ] && { echo "    zod: vendor/zod.tgz"; return 0; }
  fi
  local izvor
  for izvor in "${IZVORI[@]}"; do
    [ -d "$izvor/zod" ] || continue
    cp -r "$izvor/zod" node_modules/zod 2>/dev/null && { echo "    zod: $izvor"; return 0; }
  done
  return 1
}

k_ovisnosti() {
  # Postojeće instalacije iz kojih se ovisnosti smiju posuditi — samo izričito (TASK-5108):
  #   TM_POSUDI_IZ="/put/do/node_modules:/drugi/node_modules" bash scripts/install.sh --posudi
  IFS=: read -r -a IZVORI <<< "${TM_POSUDI_IZ:-$HOME/.claude/node_modules}"
  local zig zapis="node_modules/.tm-instalacija"
  zig="$(zig_ovisnosti)-$POSUDI"
  if [ -d node_modules/zod ] && [ ! -L node_modules/zod ] && [ "$(cat "$zapis" 2>/dev/null)" = "$zig" ]; then
    razlog "već postavljene (package.json i bun.lock nepromijenjeni)"; return 0
  fi
  promjena
  if suho; then echo "    (suho) $([ "$POSUDI" = 1 ] && echo 'povezala bih ovisnosti iz' "${IZVORI[*]}" || echo 'bun install')"; return 0; fi
  if [ "$POSUDI" = 1 ]; then
    naredba "veze node_modules → ${IZVORI[*]}"
    rm -f node_modules 2>/dev/null; mkdir -p node_modules
    local izvor p b
    for izvor in "${IZVORI[@]}"; do
      [ -d "$izvor" ] || continue
      for p in "$izvor"/*; do b="$(basename "$p")"; [ -e "node_modules/$b" ] || ln -sfn "$p" "node_modules/$b"; done
    done
    # `zod` je obavezan i NE smije se posuđivati (provjereno na oba noda 04.09.2026.)
    if [ ! -d node_modules/zod ] || [ -L node_modules/zod ]; then rm -rf node_modules/zod; osiguraj_zod || return 5; fi
  else
    naredba "bun install"
    if [ "${TM_BEZ_MREZE:-0}" = 1 ] || ! s_rokom 300 bun install; then
      echo "    bun install nije uspio (nema mreže?) — pokušavam iz priloga"
      osiguraj_zod || { echo "    GREŠKA: ovisnosti se nisu postavile"; return 5; }
    fi
  fi
  [ -d node_modules/zod ] || { echo "    GREŠKA: nedostaje obavezna ovisnost 'zod'"; return 5; }
  echo "    node_modules: $(ls node_modules | wc -l | tr -d ' ') (zod ✓$([ -d node_modules/chromadb ] && echo ', chromadb ✓' || echo ', chromadb —'))"
  printf '%s\n' "$zig" > "$zapis"
}

k_sposobnosti() {
  bez_buna && return 0
  naredba "bun scripts/sposobnosti.ts"
  if bun scripts/sposobnosti.ts >/dev/null 2>&1; then razlog "sve potrebne knjižnice postoje"; return 0; fi
  if suho || [ "$POSUDI" = 1 ]; then bun scripts/sposobnosti.ts | sed 's/^/  /'; upozori "uključena sposobnost nema knjižnicu"; return 0; fi
  promjena
  bun scripts/sposobnosti.ts --instaliraj || upozori "uključena sposobnost i dalje nema knjižnicu"
  return 0
}

k_pdf() {
  # Ne ruši instalaciju ploče — samo javi što fali (font, pip bez mreže); vidi instaliraj-pdf.sh
  # što bi instaliraj-pdf.sh napravio; neobavezni pdftotext (apt, root) i proba se ne broje
  local plan; plan="$(bash scripts/instaliraj-pdf.sh --suho 2>&1 | grep '(suho)\|❌' | grep -v 'poppler-utils\|preskočeno (suho)')"
  if [ -z "$plan" ]; then razlog "naredba pdf spremna"; return 0; fi
  if suho; then printf '%s\n' "$plan" | sed 's/^/  /'; promjena; return 0; fi
  naredba "bash scripts/instaliraj-pdf.sh"
  promjena
  bash scripts/instaliraj-pdf.sh || upozori "naredba pdf nije spremna — bash scripts/instaliraj-pdf.sh kaže što fali"
  [ -L "$HOME/.local/bin/pdf" ] && u_manifest "$HOME/.local/bin/pdf" veza
  u_manifest "${TM_PDF_VENV:-$HOME/.local/share/regoc-pdf}" mapa
  return 0
}

# ── instanca čvora ────────────────────────────────────────────────────────────
tailnet_ip() {
  local t
  for t in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale; do
    if command -v "$t" >/dev/null 2>&1 || [ -x "$t" ]; then
      s_rokom 5 "$t" ip -4 2>/dev/null | head -1 && return 0
    fi
  done
  return 1
}

instalacija_env() {    # sadržaj datoteke koju posjeduje instalacija (prepisuje se kad se razlikuje)
  echo "# instalacija.env — ZAPISUJE scripts/install.sh; ne uređuj ručno (prepisat će se)."
  echo "# Vlastite postavke idu u postavke.env (učitava se POSLIJE ove i ima prednost)."
  echo "TM_HOME=$TM_HOME"
  echo "TM_PORT=$TM_PORT"
  echo "TM_CREDENTIALS=$TM_HOME/config/credentials.env"
  [ -n "$CVOR" ] && echo "CVOR_IME=$CVOR"
  if [ "$KOMPLET" = 1 ] && [ -n "$KOMPLET_DIR" ]; then
    echo "TM_SUSTAV_DIR=$KOMPLET_DIR"
    echo "TM_MODEL_CONFIG=$KOMPLET_DIR/models/model-config.json"
  fi
  return 0
}

postavke_env() {       # početne lokalne postavke čvora — zapisuju se samo ako ih nema
  local bind="$1" hostovi="$2" vanjski="$3"
  cat <<EOF
# postavke.env čvora ${CVOR:-} — LOKALNO, nikad u repozitorij (plan P4.1). Prava 0600.
# Stvorila ju je instalacija jednom; poslije je tvoja: install.sh je više ne prepisuje.

# Adrese na koje se ploča veže. Na tuđoj mreži (Wi-Fi) nikad 0.0.0.0: petlja + tailnet.
TM_BIND=$bind
# Imena i adrese pod kojima se ploči pristupa (Host zaglavlje), zarezom.
TM_ALLOWED_HOSTS=$hostovi
TM_EXTERNAL_HOST=$vanjski
TM_PORT=$TM_PORT
EOF
}

k_instanca() {
  local dirs=("$TM_HOME" "$TM_HOME/config" "$TM_HOME/data" "$TM_HOME/log" "$TM_HOME/tmp" "$TM_HOME/backup") d nove=()
  for d in "${dirs[@]}"; do [ -d "$d" ] || nove+=("$d"); done
  if [ "${#nove[@]}" -gt 0 ]; then promjena; radi "mape ${nove[*]}" -- mkdir -p "${nove[@]}"; fi
  [ "$TM_HOME_NOV" = 1 ] && u_manifest "$TM_HOME" mapa
  # podaci, postavke i tajne čvora: samo vlasnik
  for d in "$TM_HOME" "$TM_HOME/config"; do
    if [ ! -d "$d" ] || [ "$(stat_mod "$d")" != 700 ]; then promjena; radi "chmod 700 $d" -- chmod 700 "$d"; fi
  done
  pisi_sadrzaj "$(instalacija_env)" "$TM_HOME/config/instalacija.env" 600
  [ $? = 10 ] && { promjena; echo "    $(suho && echo '(suho) ')$TM_HOME/config/instalacija.env"; }
  if [ -n "$CVOR" ]; then
    local p="$TM_HOME/config/postavke.env"
    if [ -f "$p" ]; then
      echo "    postavke.env postoji — lokalne postavke se ne prepisuju"
      [ "$(stat_mod "$p")" = 600 ] || { promjena; radi "chmod 600 $p" -- chmod 600 "$p"; }
    else
      local ip bind hostovi vanjski
      ip="$(tailnet_ip || true)"
      bind="${BIND:-127.0.0.1${ip:+,$ip}}"
      hostovi="localhost,127.0.0.1${ip:+,$ip}"
      vanjski="${ip:-localhost}"
      [ -z "$ip" ] && [ -z "$BIND" ] && echo "    tailnet nije pronađen: ploča će slušati samo na 127.0.0.1 (dodaj adresu u TM_BIND u $p)"
      promjena
      if suho; then echo "    (suho) zapisala bih $p (0600): TM_BIND=$bind"
      else postavke_env "$bind" "$hostovi" "$vanjski" > "$p" && chmod 600 "$p"; echo "    $p (0600): TM_BIND=$bind"; fi
    fi
    if [ -n "$PROFIL" ]; then
      local inst="$TM_HOME/config/profil.instanca.env"
      if [ -f "$inst" ]; then echo "    profil.instanca.env postoji — ne diram"
      else
        promjena
        if suho; then echo "    (suho) kopirala bih profili/$PROFIL/instanca.primjer.env → $inst (CVOR_IME=$CVOR)"
        else
          sed "s/^CVOR_IME=.*/CVOR_IME=$CVOR/" "$PAKET/profili/$PROFIL/instanca.primjer.env" > "$inst" && chmod 600 "$inst"
          echo "    $inst iz primjera — UPIŠI vrijednosti čvora (chat, uid, banka)"
        fi
      fi
    fi
  elif [ -n "$BIND" ]; then
    echo "    --bind bez --cvor: TM_BIND vrijedi samo za uslugu čvora (postavke.env); ovdje se ne zapisuje"
  fi
  [ "$KORAK_PROMJENA" = 1 ] || razlog "instanca $TM_HOME već postavljena"
}

k_baza() {
  [ "$BEZ_BAZE" = 1 ] && { razlog "--bez-baze"; return 0; }
  local baza="${TM_DB:-$TM_HOME/data/tasks.db}"
  if [ -f "$baza" ]; then razlog "već postoji ($baza)"; return 0; fi
  naredba "bun scripts/init-db.ts"
  promjena
  suho && { echo "    (suho) stvorila bih bazu $baza"; return 0; }
  bun scripts/init-db.ts || { echo "    GREŠKA: baza nije stvorena ($baza)"; return 6; }
  u_manifest "$baza" datoteka
}

k_rjecnici() {
  bez_buna && return 0
  naredba "bun scripts/provjeri-rjecnike.ts"
  # TASK-4713: bez locales/ i config/jezik.json ploča se digne, ali bez izbornika jezika
  bun scripts/provjeri-rjecnike.ts || {
    echo "    GREŠKA: rječnici sučelja nisu na mjestu — vrati ih iz gita: git checkout -- locales config/jezik.json"
    return 5; }
  razlog "rječnici na mjestu"
}

k_git_kuke() {
  [ -d .git ] && [ -d .githooks ] || { razlog "nije git stablo ili nema .githooks"; return 0; }
  [ "$(git config core.hooksPath 2>/dev/null)" = ".githooks" ] && { razlog "core.hooksPath = .githooks"; return 0; }
  promjena; radi "git config core.hooksPath .githooks" -- git config core.hooksPath .githooks
}

k_macos_omotaci() {
  [ "$OS" = darwin ] || { razlog "samo na macOS-u"; return 0; }
  local ime
  for ime in setsid timeout; do
    local cilj="$HOME/.local/bin/$ime"
    if [ ! -e "$cilj" ] && command -v "$ime" >/dev/null 2>&1; then echo "    $ime: postoji ($(command -v "$ime"))"; continue; fi
    [ "$ime" = timeout ] && [ ! -e "$cilj" ] && command -v gtimeout >/dev/null 2>&1 && { echo "    timeout: gtimeout postoji"; continue; }
    pisi_ako_razlicito "$PAKET/scripts/macos/bin/$ime" "$cilj" 755
    if [ $? = 10 ]; then promjena; echo "    $(suho && echo '(suho) ')$cilj"; u_manifest "$cilj" datoteka
    else echo "    $ime: $cilj (isti)"; fi
  done
  [ "$KORAK_PROMJENA" = 1 ] || razlog "omotači na mjestu"
}

k_claude() {
  if [ "$KOMPLET" = 0 ] && [ "$CLAUDE" = 0 ]; then razlog "nije traženo (uz --komplet ili --claude)"; return 0; fi
  if command -v claude >/dev/null 2>&1; then razlog "već postoji: $(claude --version 2>/dev/null | head -1)"; return 0; fi
  naredba "curl -fsSL https://claude.ai/install.sh | bash"
  promjena
  suho && { echo "    (suho) instalirala bih Claude CLI u $HOME/.local/bin"; return 0; }
  pokreni_skriptu https://claude.ai/install.sh || return 4
  command -v claude >/dev/null 2>&1 || { echo "    GREŠKA: claude se nije instalirao"; return 5; }
  u_manifest "$HOME/.local/bin/claude" datoteka; u_manifest "$HOME/.local/share/claude" mapa
  echo "    $(claude --version 2>/dev/null | head -1) — prijava je zaseban korak (Config → Prijava)"
}

# ── komplet izvornog sustava (plan P11) ────────────────────────────────────────
lock_polje() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); sys.stdout.write("" if v is None else str(v))' "$1" "$2"; }
sha256_dat() { (shasum -a 256 "$1" 2>/dev/null || sha256sum "$1") | cut -c1-64; }

k_komplet() {
  [ "$KOMPLET" = 1 ] || { razlog "nije traženo (--komplet)"; return 0; }
  local lock="$PAKET/config/komplet.lock"
  if [ ! -f "$lock" ]; then
    echo "    GREŠKA: $lock ne postoji — javni modul regoc-komplet još nije objavljen u ovom paketu."
    echo "    Instaliraj bez --komplet ili s inačicom paketa koja nosi komplet.lock (plan K3a)."
    return 5
  fi
  local repo commit msha
  repo="$(lock_polje "$lock" repo)"; commit="${KOMPLET_COMMIT:-$(lock_polje "$lock" commit)}"; msha="$(lock_polje "$lock" manifest_sha256)"
  [ -n "$repo" ] && [ -n "$commit" ] || { echo "    GREŠKA: komplet.lock nema repo ili commit"; return 5; }
  [ -n "$KOMPLET_DIR" ] || { echo "    GREŠKA: odredište kompleta nije zadano (polje odrediste u komplet.lock ili TM_KOMPLET_DIR)"; return 5; }
  naredba "git clone $repo $KOMPLET_DIR && git checkout $commit"
  if [ -e "$KOMPLET_DIR" ] && [ ! -d "$KOMPLET_DIR/.git" ]; then
    echo "    GREŠKA: $KOMPLET_DIR postoji, a nije git klon kompleta — ne prepisujem ga (premjesti ga pa ponovi)"; return 5
  fi
  if [ -d "$KOMPLET_DIR/.git" ]; then
    local izvor; izvor="$(git -C "$KOMPLET_DIR" remote get-url origin 2>/dev/null)"
    [ "$izvor" = "$repo" ] || { echo "    GREŠKA: $KOMPLET_DIR je klon $izvor, a lock traži $repo"; return 5; }
    if [ "$(git -C "$KOMPLET_DIR" rev-parse HEAD 2>/dev/null)" = "$(git -C "$KOMPLET_DIR" rev-parse "$commit^{commit}" 2>/dev/null)" ]; then
      [ -z "$(git -C "$KOMPLET_DIR" status --porcelain --untracked-files=no)" ] || { echo "    GREŠKA: komplet ima lokalne izmjene (na čvoru se ništa ne krpa, plan P3.3)"; return 5; }
      echo "    komplet na $commit"
    else
      promjena
      radi "git fetch + checkout $commit" -- bash -c "git -C '$KOMPLET_DIR' fetch -q origin && git -C '$KOMPLET_DIR' checkout -q --detach '$commit'" || return 4
    fi
  else
    promjena
    radi "git clone $repo" -- bash -c "mkdir -p '$(dirname "$KOMPLET_DIR")' && git clone -q --no-checkout '$repo' '$KOMPLET_DIR' && git -C '$KOMPLET_DIR' checkout -q --detach '$commit'" || return 4
    suho || u_manifest "$KOMPLET_DIR" mapa
  fi
  suho && [ ! -d "$KOMPLET_DIR/.git" ] && { echo "    (suho) provjerila bih MANIFEST.sha256, ovisnosti i bun build RegocDaemon.ts"; return 0; }
  # cjelovitost: MANIFEST.sha256 mora biti onaj iz locka, a datoteke moraju odgovarati manifestu
  if [ -n "$msha" ]; then
    [ -f "$KOMPLET_DIR/MANIFEST.sha256" ] || { echo "    GREŠKA: komplet nema MANIFEST.sha256"; return 5; }
    [ "$(sha256_dat "$KOMPLET_DIR/MANIFEST.sha256")" = "$msha" ] || { echo "    GREŠKA: MANIFEST.sha256 ≠ manifest_sha256 iz komplet.lock"; return 5; }
    ( cd "$KOMPLET_DIR" && { shasum -a 256 -c --quiet MANIFEST.sha256 2>/dev/null || sha256sum -c --quiet MANIFEST.sha256; } ) \
      || { echo "    GREŠKA: datoteke kompleta ne odgovaraju manifestu"; return 5; }
    echo "    manifest ✓"
  fi
  if [ -f "$KOMPLET_DIR/package.json" ] && ! bez_buna; then
    local zig zapis="$KOMPLET_DIR/node_modules/.tm-instalacija"
    zig="$(cat "$KOMPLET_DIR/package.json" "$KOMPLET_DIR/bun.lock" 2>/dev/null | (shasum -a 256 2>/dev/null || sha256sum) | cut -c1-64)"
    if [ "$(cat "$zapis" 2>/dev/null)" != "$zig" ]; then
      promjena
      radi "bun install --frozen-lockfile (komplet)" -- bash -c "cd '$KOMPLET_DIR' && bun install --frozen-lockfile" || return 5
      suho || printf '%s\n' "$zig" > "$zapis"
    fi
  fi
  # vlastita priprema kompleta (primjeri postavki, kuke, settings.json): ugovor iz plana P11 —
  # `instalacija.sh --paket P --tm-home H [--suho]` ispisuje PROMIJENJENO ili ISTO
  if [ -f "$KOMPLET_DIR/instalacija.sh" ]; then
    local izl; izl="$(bash "$KOMPLET_DIR/instalacija.sh" --paket "$PAKET" --tm-home "$TM_HOME" $(suho && echo --suho) 2>&1)" \
      || { printf '%s\n' "$izl" | sed 's/^/    /'; echo "    GREŠKA: instalacija.sh kompleta nije uspjela"; return 5; }
    printf '%s\n' "$izl" | sed 's/^/    /'
    printf '%s\n' "$izl" | grep -q '^PROMIJENJENO' && promjena
  fi
  if [ -f "$KOMPLET_DIR/RegocDaemon.ts" ] && ! suho; then
    # dokaz da se graf modula razrješava (bez toga daemon ulazi u petlju restarta, TASK-5328)
    bun build "$KOMPLET_DIR/RegocDaemon.ts" --target bun --outdir "$TM_HOME/tmp/komplet-build" >/dev/null \
      || { echo "    GREŠKA: bun build RegocDaemon.ts ne prolazi"; return 5; }
    rm -rf "$TM_HOME/tmp/komplet-build"; echo "    bun build RegocDaemon.ts ✓"
  fi
  [ "$KORAK_PROMJENA" = 1 ] || razlog "komplet na $commit, manifest i ovisnosti isti"
}

# ── lokalne baze (plan P5, P8) ─────────────────────────────────────────────────
k_baze_uv() {
  [ "$BAZE" = 1 ] || { razlog "nije traženo (--baze)"; return 0; }
  if command -v uv >/dev/null 2>&1; then razlog "već postoji: $(uv --version)"; return 0; fi
  naredba "curl -LsSf https://astral.sh/uv/install.sh | sh"
  promjena
  suho && { echo "    (suho) instalirala bih uv u $HOME/.local/bin"; return 0; }
  UV_NO_MODIFY_PATH=1 pokreni_skriptu https://astral.sh/uv/install.sh || return 4
  command -v uv >/dev/null 2>&1 || { echo "    GREŠKA: uv se nije instalirao"; return 5; }
  u_manifest "$HOME/.local/bin/uv" datoteka; u_manifest "$HOME/.local/bin/uvx" datoteka
}

k_baze_python() {
  [ "$BAZE" = 1 ] || { razlog "nije traženo (--baze)"; return 0; }
  suho && ! command -v uv >/dev/null 2>&1 && { echo "    (suho) uv python install $PYTHON_BAZE"; promjena; return 0; }
  if uv python find "$PYTHON_BAZE" >/dev/null 2>&1; then razlog "Python $PYTHON_BAZE: $(uv python find "$PYTHON_BAZE")"; return 0; fi
  naredba "uv python install $PYTHON_BAZE"
  promjena; radi "uv python install $PYTHON_BAZE" -- uv python install "$PYTHON_BAZE" || return 4
  suho || u_manifest "$HOME/.local/share/uv/python" mapa
}

venv_ima() { [ -x "$BAZE_VENV/bin/python" ] && "$BAZE_VENV/bin/python" -c "import importlib.metadata as m, sys; sys.exit(0 if m.version(sys.argv[1]) == sys.argv[2] else 1)" "$1" "$2" 2>/dev/null; }

k_baze_venv() {
  [ "$BAZE" = 1 ] || { razlog "nije traženo (--baze)"; return 0; }
  if venv_ima pg0-embedded "$PG0_VERZIJA" && venv_ima hindsight-api "$HINDSIGHT_VERZIJA"; then
    razlog "venv $BAZE_VENV: pg0-embedded $PG0_VERZIJA, hindsight-api $HINDSIGHT_VERZIJA"; return 0
  fi
  naredba "uv venv + uv pip install pg0-embedded==$PG0_VERZIJA hindsight-api==$HINDSIGHT_VERZIJA"
  promjena
  if suho; then echo "    (suho) venv $BAZE_VENV s pg0-embedded==$PG0_VERZIJA i hindsight-api==$HINDSIGHT_VERZIJA"; return 0; fi
  [ -x "$BAZE_VENV/bin/python" ] || { uv venv -q --python "$PYTHON_BAZE" "$BAZE_VENV" || return 5; u_manifest "$TM_HOME/baze" mapa; }
  s_rokom 1800 uv pip install -q --python "$BAZE_VENV/bin/python" "pg0-embedded==$PG0_VERZIJA" "hindsight-api==$HINDSIGHT_VERZIJA" || return 4
}

pg0() { HOME="$TM_HOME/rag/home" "$BAZE_VENV/bin/pg0" "$@"; }

k_baze_pgvector() {
  [ "$BAZE" = 1 ] || { razlog "nije traženo (--baze)"; return 0; }
  local spremno="$TM_HOME/rag/spremno.json"
  if [ -f "$spremno" ] && [ -f "$TM_HOME/rag/pg0/data/PG_VERSION" ]; then razlog "pgvector spreman ($(cat "$spremno"))"; return 0; fi
  naredba "pg0 start --name tm-rag -p 15433 (127.0.0.1) → CREATE EXTENSION vector → pg0 stop"
  promjena
  if suho; then echo "    (suho) inicijalizirala bih pg0 u $TM_HOME/rag/pg0 (vrata 15433, samo 127.0.0.1), ekstenziju vector, pa zaustavila"; return 0; fi
  mkdir -p "$TM_HOME/rag/home"; chmod 700 "$TM_HOME/rag"
  u_manifest "$TM_HOME/rag" mapa
  # lozinka lokalne baze: generira se ovdje, ide SAMO u spremište tajni (0600), nikad u log
  local lozinka; lozinka="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)"
  printf '%s' "$lozinka" | bun scripts/tajna.ts postavi TM_PGVECTOR_LOKALNA_PASSWORD >/dev/null || { echo "    GREŠKA: lozinka nije upisana u spremište tajni"; return 6; }
  # pg0 prima lozinku samo kao argument (vidljiv u ps): zato kreće s privremenom, jednokratnom
  # lozinkom dok sluša samo na 127.0.0.1, a prava se postavlja kroz stdin (ALTER ROLE) na kraju.
  local privremena; privremena="$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 16)"
  pg0 start --name tm-rag -p 15433 -d "$TM_HOME/rag/pg0/data" -u rag -P "$privremena" -n rag \
    -c listen_addresses=127.0.0.1 -c "unix_socket_directories=$TM_HOME/rag" >/dev/null 2>&1 \
    || { echo "    GREŠKA: pg0 start nije uspio (pg0 logs --name tm-rag)"; return 6; }
  local ext; ext="$(pg0 psql --name tm-rag -- -tAc "CREATE EXTENSION IF NOT EXISTS vector; SELECT extversion FROM pg_extension WHERE extname='vector'" 2>/dev/null | tail -1)"
  printf "ALTER ROLE rag PASSWORD '%s';\n" "$lozinka" | pg0 psql --name tm-rag -- -q >/dev/null 2>&1 \
    || { pg0 stop --name tm-rag >/dev/null 2>&1; echo "    GREŠKA: lozinka baze nije postavljena"; return 6; }
  pg0 stop --name tm-rag >/dev/null 2>&1
  [ -n "$ext" ] || { echo "    GREŠKA: ekstenzija vector nije dostupna u pg0"; return 6; }
  local bin; bin="$(ls -d "$TM_HOME"/rag/home/.pg0/installation/*/bin 2>/dev/null | tail -1)"
  printf '{"vrata":15433,"vector":"%s","bin":"%s","korisnik":"rag","baza":"rag"}\n' "$ext" "$bin" > "$spremno"
  echo "    pgvector $ext spreman i zaustavljen (uključuje ga prekidač rag.izvor=lokalna)"
}

hindsight_env() {
  cat <<EOF
# hindsight.env — lokalni Hindsight čvora; ZAPISUJE scripts/install.sh (plan P5.2). Bez tajni:
# LLM ključ (OpenRouter, …) dolazi iz spremišta tajni kroz s-okolinom.sh --tajne.
HOME=$TM_HOME/hindsight/home
HF_HOME=$TM_HOME/hindsight/hf-cache
TMPDIR=$TM_HOME/hindsight/tmp
HINDSIGHT_API_HOST=127.0.0.1
HINDSIGHT_API_PORT=17796
HINDSIGHT_API_DATABASE_URL=pg0://tm-hindsight:17797?unix_socket_directories=$TM_HOME/hindsight/tmp
HINDSIGHT_API_EMBEDDINGS_PROVIDER=local
HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL=BAAI/bge-m3
HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU=true
HINDSIGHT_API_RERANKER_PROVIDER=local
HINDSIGHT_API_RERANKER_LOCAL_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1
HINDSIGHT_API_ENABLE_OBSERVATIONS=false
HINDSIGHT_API_MCP_ENABLED=false
# LLM bira korisnik čvora (odluka 6): npr. HINDSIGHT_API_LLM_PROVIDER=openrouter u postavke.env
EOF
}

k_baze_hindsight() {
  [ "$BAZE" = 1 ] || { razlog "nije traženo (--baze)"; return 0; }
  local d="$TM_HOME/hindsight" n=()
  for x in "$d" "$d/home" "$d/hf-cache" "$d/tmp"; do [ -d "$x" ] || n+=("$x"); done
  if [ "${#n[@]}" -gt 0 ]; then promjena; radi "mape ${n[*]}" -- mkdir -p "${n[@]}"; suho || { chmod 700 "$d"; u_manifest "$d" mapa; }; fi
  pisi_sadrzaj "$(hindsight_env)" "$d/hindsight.env" 600
  [ $? = 10 ] && { promjena; echo "    $(suho && echo '(suho) ')$d/hindsight.env"; }
  [ "$KORAK_PROMJENA" = 1 ] || razlog "hindsight.env i mape na mjestu (usluga zaustavljena)"
}

k_baze_modeli() {
  [ "$BAZE" = 1 ] || { razlog "nije traženo (--baze)"; return 0; }
  local hf="$TM_HOME/hindsight/hf-cache/hub"
  if [ -d "$hf/models--BAAI--bge-m3/snapshots" ] && [ -d "$hf/models--cross-encoder--mmarco-mMiniLMv2-L12-H384-v1/snapshots" ]; then
    razlog "bge-m3 i reranker već u predmemoriji"; return 0; fi
  naredba "snapshot_download BAAI/bge-m3 + cross-encoder/mmarco-mMiniLMv2-L12-H384-v1"
  promjena
  suho && { echo "    (suho) preuzela bih bge-m3 (~2,3 GB) i reranker u $TM_HOME/hindsight/hf-cache"; return 0; }
  HF_HOME="$TM_HOME/hindsight/hf-cache" s_rokom 3600 "$BAZE_VENV/bin/python" -c '
from huggingface_hub import snapshot_download
for m in ("BAAI/bge-m3", "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1"):
    print("  ", m, snapshot_download(m))' || return 4
}

k_memorija_config() {
  local cilj="$TM_HOME/config/memorija.json"
  [ "$BAZE" = 1 ] || [ -n "$CVOR" ] || { razlog "nije čvor (--cvor) ni --baze"; return 0; }
  [ -f "$cilj" ] && { razlog "memorija.json postoji — lokalni izbor izvora se ne prepisuje"; return 0; }
  promjena
  suho && { echo "    (suho) kopirala bih config/memorija.primjer.json → $cilj (0600)"; return 0; }
  cp "$PAKET/config/memorija.primjer.json" "$cilj" && chmod 600 "$cilj"
  echo "    $cilj: memorija.izvor=nasa, rag.izvor=iskljuceno (prekidač mijenjaš lokalno)"
}

# ── usluge ────────────────────────────────────────────────────────────────────
servis_env() {
  local pg_bin=""; [ -f "$TM_HOME/rag/spremno.json" ] && pg_bin="$(sed -E 's/.*"bin":"([^"]*)".*/\1/' "$TM_HOME/rag/spremno.json")"
  env PAKET="$PAKET" TM_HOME="$TM_HOME" TM_PORT="$TM_PORT" BUN="$(command -v bun)" KOMPLET="$KOMPLET_DIR" \
    BAZE_VENV="$BAZE_VENV" PG_BIN="${pg_bin:-$TM_HOME/rag/pg0/bin}" TM_INSTALL_OS="$OS" "$@"
}

k_servis() {
  local ime="$SERVIS_IME"
  bez_buna && return 0
  naredba "bun scripts/instalacija/servis.ts primijeni --ime $ime"
  local izl kod
  izl="$(servis_env bun scripts/instalacija/servis.ts primijeni --ime "$ime" $(suho && echo --suho) 2>&1)"; kod=$?
  printf '%s\n' "$izl" | grep -v '^PROMIJENJENO$\|^ISTO$' | sed 's/^/  /'
  [ "$kod" = 0 ] || return 7
  if printf '%s\n' "$izl" | grep -q '^PROMIJENJENO$'; then
    promjena
    if [ "$OS" = darwin ]; then u_manifest "/Library/LaunchDaemons/hr.regoc.$ime.plist" usluga
    else
      u_manifest "$HOME/.config/systemd/user/regoc-$ime.service" usluga
      if [ "$ime" = znanje ]; then u_manifest "$HOME/.config/systemd/user/regoc-$ime.timer" usluga; fi
    fi
  else razlog "regoc-$ime isti i učitan"; fi
}

k_linger() {
  [ "$OS" = linux ] || { razlog "samo Linux (macOS: LaunchDaemon radi prije prijave)"; return 0; }
  command -v loginctl >/dev/null 2>&1 || { razlog "nema loginctl"; return 0; }
  [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ] && { razlog "linger već uključen"; return 0; }
  naredba "loginctl enable-linger $(id -un)"
  suho && { echo "    (suho) loginctl enable-linger $(id -un) — usluga radi i bez prijave"; promjena; return 0; }
  if loginctl enable-linger "$(id -un)" 2>/dev/null; then promjena; echo "    linger uključen"
  else upozori "linger nije uključen (treba root: sudo loginctl enable-linger $(id -un)) — usluga staje kad se odjaviš"; fi
  return 0
}

k_provjera() {
  PLOCA_URL="http://127.0.0.1:$TM_PORT"
  naredba "curl $PLOCA_URL/health"
  suho && { echo "    (suho) provjerila bih $PLOCA_URL/health (200)"; return 0; }
  local i kod=""
  for i in $(seq 1 10); do
    kod="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$PLOCA_URL/health" 2>/dev/null)"; [ "$kod" = 200 ] && break
    [ "$i" = 1 ] && [ "$BEZ_SERVISA" = 1 -o "${USLUGE_PLOCE:-0}" = 0 ] && break
    sleep 2
  done
  if [ "$kod" = 200 ]; then
    # vrata smije držati samo ploča IZ OVOG paketa (inače bi 200 dala tuđa instanca)
    local pid c; pid="$(bun src/core/platforma.ts pid-na-vratima "$TM_PORT" 2>/dev/null)"
    c="$([ -n "$pid" ] && bun src/core/platforma.ts cwd "$pid" 2>/dev/null)"
    if [ -n "$c" ] && [ "$(cd "$c" 2>/dev/null && pwd -P)" != "$PAKET" ]; then
      echo "    GREŠKA: vrata $TM_PORT drži druga ploča (PID $pid, mapa $c) — postavi TM_PORT ili je zaustavi"; return 8
    fi
    echo "    ploča radi: $PLOCA_URL/health → 200${pid:+ (PID $pid)}"; razlog "HTTP 200"; return 0
  fi
  # bez usluge: digni privremeni proces s okolinom čvora, provjeri pa ugasi
  echo "    privremeni proces ploče na vratima $TM_PORT…"
  local zapis="$TM_HOME/log/install-provjera.log"
  ( exec "$PAKET/scripts/s-okolinom.sh" -- bun src/TaskWebUI.ts ) > "$zapis" 2>&1 &
  local pid=$!
  for i in $(seq 1 40); do
    kod="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$PLOCA_URL/health" 2>/dev/null)"; [ "$kod" = 200 ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  if [ "$kod" = 200 ]; then echo "    $PLOCA_URL/health → 200 (privremeni proces ugašen)"; razlog "HTTP 200 (privremeni proces)"; return 0; fi
  echo "    GREŠKA: ploča se nije podigla (HTTP ${kod:-—}) — zadnji redci:"; tail -8 "$zapis" | sed 's/^/      /'
  return 8
}

k_manifest() {
  local put="$TM_HOME/instalirano.json"
  [ "${#MANIFEST_NOVO[@]}" -gt 0 ] || { razlog "ništa novo izvan git stabla"; return 0; }
  suho && { echo "    (suho) dopisala bih ${#MANIFEST_NOVO[@]} stavki u $put"; promjena; return 0; }
  local izl; izl="$(printf '%s\n' "${MANIFEST_NOVO[@]}" | bun scripts/instalacija/manifest.ts "$put")" || return 5
  echo "    $izl"
  case "$izl" in *"dodano 0"*) razlog "sve stavke već u manifestu" ;; *) promjena ;; esac
}

k_ai_prijava() {
  bez_buna && return 0
  # odluka 6: instalacija ne pita za AI servis i ne upisuje ključ — samo pokaže stanje i put
  naredba "bun scripts/prijava-ai.ts popis"
  local mc=""; [ "$KOMPLET" = 1 ] && [ -n "$KOMPLET_DIR" ] && mc="$KOMPLET_DIR/models/model-config.json"
  TM_HOME="$TM_HOME" bun scripts/prijava-ai.ts popis --kratko ${mc:+--model-config "$mc"} 2>&1 | sed 's/^/    /'
  razlog "samo ispis (prijavu bira korisnik)"
  return 0
}

# ═════════════════════════════════════════════════════════════════════════════
OS=""; OS_OPIS=""; PLOCA_URL=""
BACKUP_DIR="$TM_HOME/backup/install-$(date '+%Y%m%d-%H%M%S')"
# je li $TM_HOME nastao ovom instalacijom (mapa loga ga stvara prije koraka instance)
TM_HOME_NOV=0; [ -e "$TM_HOME" ] || TM_HOME_NOV=1
log_otvori "${LOG_DIR_ARG:-$TM_HOME/log/install}" || exit 3
zapis_log "TaskManagerAI — instalacija iz $PAKET$(suho && echo '  [SUHO: ništa se ne piše]')"
zapis_log "  argumenti: ${ARGUMENTI:-—}"

korak K2.1-os          "otkrivanje OS-a"                         k_os 3
zapis_okolinu
korak K2.2-stablo      "radno stablo paketa i lokalne postavke"  k_stablo 3
korak K2.3-preduvjeti  "preduvjeti (i macOS zamjene, plan P10)"  k_preduvjeti 3
korak K2.4-bun         "bun u ~/.bun"                             k_bun 4
korak K2.5-ovisnosti   "ovisnosti paketa (node_modules)"         k_ovisnosti 5
korak K2.6-sposobnosti "knjižnice uključenih sposobnosti"        k_sposobnosti 5
korak K2.7-pdf         "naredba pdf"                              k_pdf 5
korak K2.8-instanca    "instanca: \$TM_HOME i postavke čvora"    k_instanca 3
korak K2.9-baza        "baza zadataka"                            k_baza 6
korak K2.10-rjecnici   "rječnici sučelja"                        k_rjecnici 5
korak K2.11-git-kuke   "git kuke (core.hooksPath)"               k_git_kuke 5
korak K2.12-macos-omotaci "macOS: setsid i timeout u ~/.local/bin" k_macos_omotaci 5
korak K2.13-claude     "Claude CLI"                              k_claude 4
korak K2.14-komplet    "komplet izvornog sustava (regoc-komplet)" k_komplet 5
korak K2.15-baze-uv    "uv (Python za lokalne baze)"             k_baze_uv 4
korak K2.16-baze-python "Python $PYTHON_BAZE"                    k_baze_python 4
korak K2.17-baze-venv  "venv: pg0 + hindsight-api"               k_baze_venv 5
korak K2.18-baze-pgvector "lokalni pgvector (zaustavljen)"       k_baze_pgvector 6
korak K2.19-baze-hindsight "lokalni Hindsight (zaustavljen)"     k_baze_hindsight 6
korak K2.20-baze-modeli "modeli bge-m3 + reranker"               k_baze_modeli 4
korak K2.21-memorija   "prekidači memorija.izvor / rag.izvor"    k_memorija_config 6
k_bez_usluga() { razlog "$([ "$BEZ_SERVISA" = 1 ] && echo '--bez-servisa' || echo 'bez --cvor usluge se ne postavljaju (ploča: bash scripts/start.sh)')"; }
popis_usluga() {   # imena usluga za uvjete (python3: radi i uz --suho prije buna)
  python3 -c 'import json,sys; [print(u["ime"]) for u in json.load(open(sys.argv[1]))["usluge"] if u["uvjet"] in sys.argv[2].split(",")]' \
    "$PAKET/templates/servis/usluge.json" "$1"
}
USLUGE_PLOCE=0
if [ "$BEZ_SERVISA" = 1 ] || [ -z "$CVOR" ]; then
  korak K2.22-servis "usluge" k_bez_usluga 7
else
  korak K2.22-linger "systemd linger" k_linger 7
  UVJETI="uvijek"; [ "$KOMPLET" = 1 ] && UVJETI="$UVJETI,komplet"; [ "$BAZE" = 1 ] && UVJETI="$UVJETI,baze"
  for SERVIS_IME in $(popis_usluga "$UVJETI"); do
    korak "K2.23-servis-$SERVIS_IME" "usluga regoc-$SERVIS_IME" k_servis 7
  done
  USLUGE_PLOCE=1
fi
korak K2.24-provjera   "provjera: /health → 200"                 k_provjera 8
korak K2.25-manifest   "manifest instalirano.json"               k_manifest 5
korak K2.26-ai-prijava "AI servisi: stanje prijave"              k_ai_prijava 5

ZAVRSENO=1
zapis_rezultat "$(suho && echo suho || echo uspjeh)" "" 0 "promijenjeno $N_PROMIJENJENO, preskočeno $N_PRESKOCENO"
echo
if [ "$N_PROMIJENJENO" = 0 ]; then zapis_log "GOTOVO: 0 promjena ($N_KORAKA koraka, sve već postavljeno)"
else zapis_log "GOTOVO: promijenjeno $N_PROMIJENJENO, preskočeno $N_PRESKOCENO$(suho && echo ' (suho — ništa nije zapisano)')"; fi
for u in "${UPOZORENJA[@]+"${UPOZORENJA[@]}"}"; do zapis_log "  upozorenje: $u"; done
[ -n "$LOG_DIR" ] && echo "log:    $LOG_DIR  (zadnji: $LOG_RODITELJ/zadnji)"
echo "ploča:  http://127.0.0.1:$TM_PORT$([ -z "$CVOR" ] && echo '  (pokreni: bash scripts/start.sh)')"
if [ -n "$CVOR" ]; then
  echo "lokalno upiši (ništa od ovoga ne ide u repozitorij):"
  echo "  • $TM_HOME/config/postavke.env — TM_BIND, TM_ALLOWED_HOSTS"
  [ -n "$PROFIL" ] && echo "  • $TM_HOME/config/profil.instanca.env — chat, uid, banka čvora"
  echo "  • tajne: bun scripts/tajna.ts postavi IME (vrijednost na upit), ili Config → Tajne"
  echo "  • AI servis po izboru: bun scripts/prijava-ai.ts (čarobnjak) ili Config → Prijava"
fi
exit 0
