#!/usr/bin/env bash
# deinstaliraj.sh — uklanjanje TaskManagerAI s čvora u tri razine (plan Mac v3 P3, P3.4).
#
#   bash scripts/deinstaliraj.sh                 # usluge i naredbe pdf/glas; podaci ostaju
#   bash scripts/deinstaliraj.sh --sve           # + $TM_HOME (prije toga kopija u ~/taskmanager-backup-<vrijeme>.tgz)
#   bash scripts/deinstaliraj.sh --do-nule       # + SVE što je instalacija donijela, PO MANIFESTU
#   bash scripts/deinstaliraj.sh --suho [--do-nule]   # samo ispiše što bi uklonila, ništa ne dira
#
# Opcije:
#   --sve          uz usluge i $TM_HOME (podaci, postavke, tajne čvora) — nakon kopije
#   --do-nule      uz --sve i svaki put iz $TM_HOME/instalirano.json (bun, Claude CLI, uv i
#                  Python, venvovi, pg0, modeli, predmemorije…), označene retke u ~/.zshrc,
#                  ~/.bashrc… i redak tm-tunel u ~/.ssh/authorized_keys; na kraju provjeri-cisto
#   --bez-kopije   uz --sve/--do-nule bez kopije $TM_HOME (krug petlje popravka, P3.3)
#   --da           bez pitanja za potvrdu (SSH, skripte); bez terminala se ionako ne pita
#   --suho         ništa ne mijenja; ispisuje svaki korak i svaki put koji bi uklonila
#
# Briše SAMO ono što je instalacija upisala u manifest (i usluge paketa iz
# templates/servis/usluge.json). Ništa izvan $HOME osim /Library/LaunchDaemons/hr.regoc.*.plist:
# tuđi Homebrew, tailscale i datoteke vlasnika stroja ostaju netaknuti — svaki put iz
# manifesta prolazi branu `smije_obrisati` (ispod), a odbijeni se ispisuju i broje.
# Logovi krugova instalacije sele u ~/.taskmanager-log-arhiva/install/ (provjeri-cisto ih
# ne broji), a zapis deinstalacije ide u …/deinstalacija/<vrijeme>/ (format P3.1).
# Izlaz: 0 uspjeh · 2 uporaba · 3 preduvjet (sudo za LaunchDaemon) · 7 usluga · 8 ostaci nakon
#        --do-nule (provjeri-cisto ≠ 0) · 9 put iz manifesta odbijen na brani · 130 prekinuto.
set -uo pipefail
export LC_NUMERIC=C

PAKET="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$PAKET" || exit 1
ZAPIS_IME=deinstalacija
# shellcheck source=scripts/instalacija/zapis.sh
. "$PAKET/scripts/instalacija/zapis.sh"
# shellcheck source=scripts/instalacija/rc.sh
. "$PAKET/scripts/instalacija/rc.sh"

ARGUMENTI="$*"
RAZINA=usluge; SUHO=0; BEZ_KOPIJE=0; DA=0
while [ $# -gt 0 ]; do
  case "$1" in
    --sve)        [ "$RAZINA" = do-nule ] || RAZINA=sve ;;
    --do-nule)    RAZINA=do-nule ;;
    --bez-kopije) BEZ_KOPIJE=1 ;;
    --da)         DA=1 ;;
    --suho)       SUHO=1 ;;
    -h|--help)    sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "nepoznat argument: $1 (pomoć: bash scripts/deinstaliraj.sh --help)" >&2; exit 2 ;;
  esac
  shift
done

TM_HOME="${TM_HOME:-$HOME/.taskmanager}"
ARHIVA="${TM_LOG_ARHIVA:-$HOME/.taskmanager-log-arhiva}"
LAUNCHD_DIR="${TM_LAUNCHD_DIR:-/Library/LaunchDaemons}"
SYSTEMD_DIR="$HOME/.config/systemd/user"
MANIFEST="$TM_HOME/instalirano.json"
OS="${TM_INSTALL_OS:-$(uname -s)}"
case "$OS" in Darwin|darwin) OS=darwin; OS_OPIS="macOS $(sw_vers -productVersion 2>/dev/null) $(uname -m)" ;;
  *) OS=linux; OS_OPIS="Linux $(uname -m)" ;; esac
VRIJEME="$(date '+%Y%m%d-%H%M%S')"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
suho() { [ "$SUHO" = 1 ]; }

# ── manifest: put|vrsta po retku (bez Pythona i buna: format piše manifest.ts) ─────────
ucitaj_manifest() {   # ucitaj_manifest DATOTEKA → retci „put|vrsta"
  [ -f "$1" ] || return 0
  awk '
    /"put":/   { p = $0; sub(/^[^:]*:[[:space:]]*"/, "", p); sub(/",?[[:space:]]*$/, "", p) }
    /"vrsta":/ { v = $0; sub(/^[^:]*:[[:space:]]*"/, "", v); sub(/",?[[:space:]]*$/, "", v); if (p != "") print p "|" v; p = "" }
  ' "$1"
}
# Ako je $TM_HOME već obrisan (ponovljeni --do-nule), vrijedi zadnja arhivirana kopija.
MANIFEST_IZVOR="$MANIFEST"
[ -f "$MANIFEST_IZVOR" ] || MANIFEST_IZVOR="$(ls -1t "$ARHIVA"/manifest/*.json 2>/dev/null | head -1)"
STAVKE=()
while IFS= read -r r; do [ -n "$r" ] && STAVKE+=("$r"); done < <(ucitaj_manifest "${MANIFEST_IZVOR:-/nema}")
u_manifestu() {   # u_manifestu PUT [VRSTA]
  local s; for s in "${STAVKE[@]+"${STAVKE[@]}"}"; do
    [ "${s%%|*}" = "$1" ] && { [ -z "${2:-}" ] || [ "${s#*|}" = "$2" ]; } && return 0
  done; return 1
}

# ── brana: što se smije obrisati ───────────────────────────────────────────────
HOME_STVARNI="$(cd "$HOME" 2>/dev/null && pwd -P)"
ZASTICENO=" $HOME $HOME/.ssh $HOME/Library $HOME/Desktop $HOME/Documents $HOME/Downloads $HOME/Movies \
$HOME/Music $HOME/Pictures $HOME/Public $HOME/Applications $HOME/.config $HOME/.local $HOME/.local/bin \
$HOME/.local/share $HOME/.local/state $HOME/.cache $HOME/.zshrc $HOME/.zprofile $HOME/.bashrc \
$HOME/.bash_profile $HOME/.profile $HOME/.gitconfig $ARHIVA "
# smije_obrisati PUT → 0 ako smije; inače ispiše razlog i vrati 1
smije_obrisati() {
  local p="$1"
  case "$p" in /*) ;; *) echo "nije apsolutna putanja"; return 1 ;; esac
  case "$p/" in */../*|*/./*|*//*) echo "putanja s . ili .. ili //"; return 1 ;; esac
  case "$p" in "$LAUNCHD_DIR"/hr.regoc.*.plist) return 0 ;; esac
  case "$p" in "$HOME"/?*) ;; *) echo "izvan $HOME"; return 1 ;; esac
  case "$ZASTICENO" in *" $p "*) echo "zaštićena mapa"; return 1 ;; esac
  case "$p" in "$HOME/.ssh/"*|"$ARHIVA/"*) echo "zaštićeno ($HOME/.ssh, arhiva logova)"; return 1 ;; esac
  case "$PAKET/" in "$p/"*) echo "sadrži paket iz kojeg radim ($PAKET)"; return 1 ;; esac
  # roditelj mora stvarno biti pod $HOME (veza u putanji ne smije izvesti van)
  local rod; rod="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 0   # roditelja nema → nema ni puta
  case "$rod/" in "$HOME_STVARNI"/*) ;; *) echo "roditelj $rod nije pod $HOME_STVARNI"; return 1 ;; esac
  return 0
}

# ── okvir koraka (isti zapis kao install.sh, P3.1) ────────────────────────────
N_PROMIJENJENO=0; N_PRESKOCENO=0; N_KORAKA=0; N_ODBIJENO=0; PRVI_PAD=0; PRVI_PAD_KORAK=""
TRENUTNI_KORAK=""; ZAVRSENO=0
promjena() { KORAK_PROMJENA=1; }
razlog()   { KORAK_RAZLOG="$*"; }
upozori()  { KORAK_UPOZORENJE="$*"; }
# ukloni PUT [opis] — rm uz branu; veza se briše kao veza (ne prati se)
ukloni() {
  local p="$1" zasto
  { [ -e "$p" ] || [ -L "$p" ]; } || return 0
  if ! zasto="$(smije_obrisati "$p")"; then
    echo "    ODBIJENO $p — $zasto"; N_ODBIJENO=$((N_ODBIJENO + 1)); return 0
  fi
  promjena
  if suho; then echo "    (suho) uklonila bih $p"; return 0; fi
  case "$p" in "$LAUNCHD_DIR"/*) sudo -n rm -f "$p" || { echo "    GREŠKA: sudo rm $p"; return 7; } ;;
    *) rm -rf "$p" || { echo "    GREŠKA: rm $p"; return 1; } ;; esac
  echo "    uklonjeno $p"
}
korak() {   # korak ID OPIS FUNKCIJA [KOD_PADA] [stani]
  local id="$1" opis="$2" fn="$3" kat="${4:-1}" stani="${5:-}"
  TRENUTNI_KORAK="$id"; KORAK_PROMJENA=0; KORAK_RAZLOG=""; KORAK_UPOZORENJE=""
  N_KORAKA=$((N_KORAKA + 1))
  zapis_log "── $id  $opis"
  local t0 kod tekst rep; t0="$(sad_s)"
  if suho; then "$fn" 2>&1; kod=$?; rep=""
  else
    local out="${TMPDIR:-/tmp}/deinstaliraj-$$.out"
    "$fn" > "$out" 2>&1; kod=$?
    tekst="$(zatamni < "$out")"; rm -f "$out"
    [ -n "$tekst" ] && zapis_log "$tekst"
    rep="$(printf '%s\n' "$tekst" | tail -20)"
  fi
  [ "$kod" != 0 ] && { [ "$kod" -lt 3 ] || [ "$kod" -gt 9 ]; } && kod="$kat"
  local prom=false; [ "$KORAK_PROMJENA" = 1 ] && prom=true
  zapis_korak "$id" "$opis" "" "$kod" "$(razlika_s "$t0" "$(sad_s)")" "$prom" "$KORAK_RAZLOG" "$rep" "$KORAK_UPOZORENJE"
  if [ "$kod" != 0 ]; then
    zapis_log "  ✗ $id pao (izlaz $kod)"
    [ "$PRVI_PAD" = 0 ] && { PRVI_PAD="$kod"; PRVI_PAD_KORAK="$id"; }
    if [ "$stani" = stani ]; then
      ZAVRSENO=1; zapis_rezultat pad "$id" "$kod" "$(printf '%s\n' "$rep" | grep -v '^[[:space:]]*$' | tail -1)"
      [ -n "${LOG_DIR:-}" ] && echo "log: $LOG_DIR"; exit "$kod"
    fi
    return 0
  fi
  if [ "$KORAK_PROMJENA" = 1 ]; then N_PROMIJENJENO=$((N_PROMIJENJENO + 1)); zapis_log "  ✓ promijenjeno"
  else N_PRESKOCENO=$((N_PRESKOCENO + 1)); zapis_log "  ✓ ${KORAK_RAZLOG:-ništa za ukloniti}"; fi
}
na_kraju() { local k=$?; [ "$ZAVRSENO" = 1 ] && return; ZAVRSENO=1
  zapis_rezultat pad "${TRENUTNI_KORAK:-pocetak}" "$([ "$k" = 0 ] && echo 1 || echo "$k")" "deinstalacija je izašla izvan koraka (izlaz $k)"; }
na_prekid() { ZAVRSENO=1; zapis_rezultat prekinuto "${TRENUTNI_KORAK:-pocetak}" 130 "prekinuto signalom $1"; echo; echo "prekinuto ($1)"; exit 130; }
trap na_kraju EXIT
trap 'na_prekid INT' INT
trap 'na_prekid TERM' TERM

# ═════════════════════════════════════════════════════════════════════════════
# KORACI
# ═════════════════════════════════════════════════════════════════════════════

# Usluge: one iz manifesta (vrsta usluga) + usluge paketa iz usluge.json koje postoje.
imena_usluga() {
  { sed -n 's/^[[:space:]]*"ime":[[:space:]]*"\([a-z0-9-]*\)".*/\1/p' "$PAKET/templates/servis/usluge.json" 2>/dev/null
    local s p; for s in "${STAVKE[@]+"${STAVKE[@]}"}"; do
      [ "${s#*|}" = usluga ] || continue; p="${s%%|*}"; p="${p##*/}"
      case "$p" in hr.regoc.*.plist) p="${p#hr.regoc.}"; echo "${p%.plist}" ;;
        regoc-*.service|regoc-*.timer) p="${p#regoc-}"; echo "${p%.*}" ;; esac
    done; } | sort -u
}
d_usluge() {
  local ime n=0
  if [ "$OS" = darwin ]; then
    local trebam_sudo=0
    for ime in $(imena_usluga); do
      { [ -e "$LAUNCHD_DIR/hr.regoc.$ime.plist" ] || launchctl print "system/hr.regoc.$ime" >/dev/null 2>&1; } && trebam_sudo=1
    done
    if [ "$trebam_sudo" = 1 ] && ! suho && ! sudo -n true 2>/dev/null; then
      echo "    GREŠKA: LaunchDaemon uklanja samo administrator: pokreni 'sudo -v' (lozinka), pa ponovi"; return 3
    fi
    for ime in $(imena_usluga); do
      local o="hr.regoc.$ime" plist="$LAUNCHD_DIR/hr.regoc.$ime.plist"
      if launchctl print "system/$o" >/dev/null 2>&1 || sudo -n launchctl print "system/$o" >/dev/null 2>&1; then
        promjena; n=$((n + 1))
        if suho; then echo "    (suho) launchctl bootout system/$o"
        else sudo -n launchctl bootout "system/$o" 2>&1 | sed 's/^/    /'; echo "    zaustavljeno system/$o"; fi
      fi
      ukloni "$plist" || return 7
    done
  else
    local datoteke=() f
    for ime in $(imena_usluga); do
      for f in "$SYSTEMD_DIR/regoc-$ime.timer" "$SYSTEMD_DIR/regoc-$ime.service"; do [ -e "$f" ] && datoteke+=("$f"); done
    done
    for f in "${datoteke[@]+"${datoteke[@]}"}"; do
      promjena; n=$((n + 1))
      if suho; then echo "    (suho) systemctl --user disable --now ${f##*/}"
      else systemctl --user disable --now "${f##*/}" >/dev/null 2>&1 && echo "    zaustavljeno ${f##*/}" \
        || echo "    ${f##*/}: systemd korisnička sesija ne odgovara — uklanjam samo datoteku"; fi
      ukloni "$f" || return 7
    done
    [ "${#datoteke[@]}" -gt 0 ] && ! suho && systemctl --user daemon-reload >/dev/null 2>&1
  fi
  [ "$KORAK_PROMJENA" = 1 ] || razlog "nema usluga paketa"
  return 0
}

# Procesi koji su ostali bez usluge (ručno pokrenuta ploča, siroče pg0): samo procesi OVOG
# korisnika čija naredba sadrži put instalacije ($TM_HOME, mape iz manifesta), ili koji drže
# naša vrata, a radna mapa im je paket. Nikad ova skripta ni njezini preci.
preci() { local p=$$; while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do echo "$p"; p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"; done; }
cwd_procesa() {
  if [ -e "/proc/$1/cwd" ]; then readlink "/proc/$1/cwd" 2>/dev/null
  else lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; fi
}
d_procesi() {
  local nasi=" $(preci | tr '\n' ' ') " uzorci=("$TM_HOME/") s pid args p kandidati=""
  for s in "${STAVKE[@]+"${STAVKE[@]}"}"; do
    case "${s#*|}" in mapa|datoteka) p="${s%%|*}"; case "$p" in "$TM_HOME"|"$TM_HOME"/*) ;; *) uzorci+=("$p/" "$p ") ;; esac ;; esac
  done
  while read -r pid args; do
    case "$nasi" in *" $pid "*) continue ;; esac
    for p in "${uzorci[@]}"; do case "$args " in *"$p"*) kandidati="$kandidati $pid"; break ;; esac; done
  done < <(ps -U "$(id -u)" -o pid=,args= 2>/dev/null)
  local v
  for v in 17781 17792 17796 17797 15433; do
    if command -v lsof >/dev/null 2>&1; then pid="$(lsof -nP -iTCP:"$v" -sTCP:LISTEN -t 2>/dev/null | head -1)"
    elif command -v bun >/dev/null 2>&1; then pid="$(bun src/core/platforma.ts pid-na-vratima "$v" 2>/dev/null | grep -E '^[0-9]+$')"
    else pid=""; fi
    [ -n "$pid" ] || continue
    case "$nasi" in *" $pid "*) continue ;; esac
    [ "$(cd "$(cwd_procesa "$pid")" 2>/dev/null && pwd -P)" = "$PAKET" ] && kandidati="$kandidati $pid"
  done
  kandidati="$(printf '%s\n' $kandidati | sort -un | tr '\n' ' ')"
  [ -n "${kandidati// /}" ] || { razlog "nema zaostalih procesa"; return 0; }
  promjena
  for pid in $kandidati; do echo "    PID $pid: $(ps -o args= -p "$pid" 2>/dev/null | cut -c1-100)"; done
  suho && { echo "    (suho) zaustavila bih ih (TERM, nakon 5 s KILL)"; return 0; }
  kill $kandidati 2>/dev/null
  local i; for i in 1 2 3 4 5 6 7 8 9 10; do
    local zivi=""; for pid in $kandidati; do kill -0 "$pid" 2>/dev/null && zivi="$zivi $pid"; done
    [ -z "$zivi" ] && break; sleep 0.5
  done
  [ -n "${zivi:-}" ] && { echo "    nisu stali na TERM:$zivi → KILL"; kill -9 $zivi 2>/dev/null; }
  return 0
}

# Naredbe u ~/.local/bin koje je postavio paket: iz manifesta, ili veza/skripta koja vodi u paket.
d_naredbe() {
  local ime f
  for ime in pdf glas; do
    f="$HOME/.local/bin/$ime"
    { [ -e "$f" ] || [ -L "$f" ]; } || continue
    if u_manifestu "$f" || { [ -L "$f" ] && case "$(readlink "$f")" in "$PAKET"/*|*/regoc-pdf/*|*/regoc-glas/*) true ;; *) false ;; esac; } \
       || { [ -f "$f" ] && grep -qF "$PAKET" "$f" 2>/dev/null; }; then
      ukloni "$f" || return $?
    else echo "    $f nije od paketa (nije u manifestu, ne vodi u $PAKET) — ostaje"; fi
  done
  [ "$KORAK_PROMJENA" = 1 ] || razlog "nema naredbi paketa u ~/.local/bin"
  return 0
}

d_kopija() {
  [ -d "$TM_HOME" ] || { razlog "$TM_HOME ne postoji"; return 0; }
  [ "$BEZ_KOPIJE" = 1 ] && { razlog "--bez-kopije"; return 0; }
  KOPIJA="$HOME/taskmanager-backup-$VRIJEME.tgz"
  promjena
  if suho; then echo "    (suho) kopija baze (scripts/backup.ts) i $TM_HOME → $KOPIJA (0600)"; return 0; fi
  if command -v bun >/dev/null 2>&1 && [ -f "${TM_DB:-$TM_HOME/data/tasks.db}" ]; then
    TM_HOME="$TM_HOME" TM_BACKUP_KEEP=1000 bun scripts/backup.ts 2>&1 | sed 's/^/    /'
  fi
  # bez velikih stvari koje se mogu ponovo preuzeti (modeli, venv, binarke pg0) i bez logova instalacije
  ( umask 077; tar -czf "$KOPIJA" -C "$(dirname "$TM_HOME")" \
      --exclude "$(basename "$TM_HOME")/log/install" --exclude "$(basename "$TM_HOME")/tmp" \
      --exclude "$(basename "$TM_HOME")/hindsight/hf-cache" --exclude "$(basename "$TM_HOME")/baze" \
      --exclude '*/.pg0/installation' "$(basename "$TM_HOME")" ) \
    || { echo "    GREŠKA: kopija $KOPIJA nije uspjela — $TM_HOME NE brišem"; return 6; }
  echo "    kopija: $KOPIJA ($(du -h "$KOPIJA" | cut -f1))"
}

d_arhiva_logova() {
  local izvor="$TM_HOME/log/install" d n
  # manifest se čuva u arhivi: provjeri-cisto po njemu traži ostatke i kad $TM_HOME više nema
  if [ -f "$MANIFEST" ]; then
    promjena
    if suho; then echo "    (suho) $MANIFEST → $ARHIVA/manifest/instalirano-$VRIJEME.json"
    else mkdir -p "$ARHIVA/manifest" && chmod 700 "$ARHIVA" && cp -p "$MANIFEST" "$ARHIVA/manifest/instalirano-$VRIJEME.json"; fi
  fi
  [ -d "$izvor" ] || { [ "$KORAK_PROMJENA" = 1 ] || razlog "nema $izvor"; return 0; }
  promjena
  if suho; then echo "    (suho) $izvor/* → $ARHIVA/install/"; return 0; fi
  mkdir -p "$ARHIVA/install"; chmod 700 "$ARHIVA" "$ARHIVA/install"
  for d in "$izvor"/*/; do
    d="${d%/}"; [ -d "$d" ] && [ ! -L "$d" ] || continue
    n="$ARHIVA/install/$(basename "$d")"; [ -e "$n" ] && n="$n-$VRIJEME"
    mv "$d" "$n" || { echo "    GREŠKA: premještanje $d"; return 1; }
  done
  ln -sfn "$(ls -1 "$ARHIVA/install" | grep -E '^[0-9]{8}-[0-9]{6}' | sort | tail -1)" "$ARHIVA/install/zadnji" 2>/dev/null
  echo "    logovi instalacije → $ARHIVA/install/ ($(ls -1 "$ARHIVA/install" | grep -c '^[0-9]') krugova)"
}

d_tm_home() {
  [ -e "$TM_HOME" ] || { razlog "$TM_HOME ne postoji"; return 0; }
  ukloni "$TM_HOME"
}

# Sve iz manifesta: dublje prije pliće; zajedničke roditeljske mape samo ako su prazne.
d_manifest() {
  [ "${#STAVKE[@]}" -gt 0 ] || { razlog "manifest prazan ili ga nema (${MANIFEST_IZVOR:-—})"; return 0; }
  echo "    manifest: ${MANIFEST_IZVOR} (${#STAVKE[@]} stavki)"
  local s p v
  while IFS='|' read -r p v; do
    case "$v" in usluga|rc|rc-nova|mapa-ako-prazna) continue ;; esac
    ukloni "$p" || return $?
  done < <(for s in "${STAVKE[@]}"; do printf '%s\t%s\n' "${#s}" "$s"; done | sort -rn | cut -f2-)
  while IFS='|' read -r p v; do
    [ "$v" = mapa-ako-prazna ] && [ -d "$p" ] || continue
    if [ -n "$(ls -A "$p" 2>/dev/null)" ]; then echo "    $p nije prazna — ostaje (u njoj je i tuđe)"; continue; fi
    smije_obrisati "$p" >/dev/null || [ "$p" = "$HOME/.local" ] || [ "$p" = "$HOME/.cache" ] || [ "$p" = "$HOME/.config" ] \
      || [ "$p" = "$HOME/.local/bin" ] || [ "$p" = "$HOME/.local/share" ] || [ "$p" = "$HOME/.local/state" ] || continue
    promjena
    if suho; then echo "    (suho) rmdir $p"; else rmdir "$p" 2>/dev/null && echo "    uklonjena prazna mapa $p"; fi
  done < <(for s in "${STAVKE[@]}"; do printf '%s\t%s\n' "${#s}" "$s"; done | sort -rn | cut -f2-)
  [ "$KORAK_PROMJENA" = 1 ] || razlog "ništa iz manifesta više ne postoji"
  return 0
}

d_rc() {
  local f
  while IFS= read -r f; do
    [ -f "$f" ] && grep -q "^$RC_OZNAKA_POCETAK" "$f" || continue
    promjena
    if suho; then echo "    (suho) uklonila bih označene retke iz $f:"; awk -v p="$RC_OZNAKA_POCETAK" -v k="$RC_OZNAKA_KRAJ" 'index($0,p)==1{u=1} u{print "      " $0} index($0,k)==1{u=0}' "$f"; continue; fi
    [ -n "${LOG_DIR:-}" ] && cp -p "$f" "$LOG_DIR/$(basename "$f").prije"
    rc_ukloni "$f" && echo "    $f: uklonjeni retci između oznaka TaskManagerAI"
    if u_manifestu "$f" rc-nova && ! grep -q '[^[:space:]]' "$f"; then rm -f "$f"; echo "    $f: stvorila ju je instalacija i sad je prazna — uklonjena"; fi
  done < <(rc_datoteke)
  [ "$KORAK_PROMJENA" = 1 ] || razlog "nema označenih redaka"
  return 0
}

d_kljuc() {
  # Samo redak čiji je KOMENTAR ključa točno tm-tunel (TASK-5686, N2): tuđi ključ s tim
  # podnizom u komentaru (npr. „tm-tunel-x") ostaje.
  local f="$HOME/.ssh/authorized_keys" oznaka='[[:space:]]tm-tunel$'
  [ -f "$f" ] && grep -Eq "$oznaka" "$f" || { razlog "nema retka tm-tunel"; return 0; }
  promjena
  suho && { echo "    (suho) uklonila bih $(grep -Ec "$oznaka" "$f") redak/retka s oznakom tm-tunel iz $f"; return 0; }
  [ -n "${LOG_DIR:-}" ] && cp -p "$f" "$LOG_DIR/authorized_keys.prije" && chmod 600 "$LOG_DIR/authorized_keys.prije"
  grep -Ev "$oznaka" "$f" > "$f.tm-novo"; cat "$f.tm-novo" > "$f"; rm -f "$f.tm-novo"
  echo "    $f: uklonjen redak tunela (tm-tunel)"
}

d_provjera() {
  suho && { echo "    (suho) na kraju bih pokrenula scripts/provjeri-cisto.sh"; return 0; }
  local izl; izl="$(bash "$PAKET/scripts/provjeri-cisto.sh" 2>&1)"; local k=$?
  printf '%s\n' "$izl" | sed 's/^/    /'
  [ "$k" = 0 ] && { razlog "provjeri-cisto: 0 ostataka"; return 0; }
  return 8
}

# ═════════════════════════════════════════════════════════════════════════════
if [ "$RAZINA" != usluge ] && ! suho && [ "$DA" = 0 ] && [ -t 0 ]; then
  echo "deinstaliraj.sh --$RAZINA briše $TM_HOME$([ "$RAZINA" = do-nule ] && echo " i sve iz manifesta ($MANIFEST_IZVOR)")."
  printf 'Upiši DA za nastavak: '; read -r odg; [ "$odg" = DA ] || { echo "odustajem"; ZAVRSENO=1; exit 2; }
fi
if [ "$RAZINA" = usluge ]; then RODITELJ="$TM_HOME/log/deinstalacija"; else RODITELJ="$ARHIVA/deinstalacija"; fi
if suho; then log_otvori "$RODITELJ"
else mkdir -p "$(dirname "$RODITELJ")" && chmod 700 "$(dirname "$RODITELJ")"; log_otvori "$RODITELJ" || exit 3; fi
zapis_log "TaskManagerAI — deinstalacija (razina: $RAZINA) iz $PAKET$(suho && echo '  [SUHO: ništa se ne mijenja]')"
zapis_log "  TM_HOME: $TM_HOME · manifest: ${MANIFEST_IZVOR:-nema} (${#STAVKE[@]} stavki) · OS: $OS_OPIS"

korak D1-usluge   "usluge (launchd/systemd) paketa"            d_usluge 7 stani
korak D2-procesi  "zaostali procesi instalacije"               d_procesi 1
korak D3-naredbe  "naredbe pdf i glas u ~/.local/bin"           d_naredbe 1
if [ "$RAZINA" != usluge ]; then
  korak D4-kopija   "kopija \$TM_HOME (backup.ts + tgz)"        d_kopija 6 stani
  korak D5-arhiva   "logovi instalacije i manifest → arhiva"    d_arhiva_logova 1 stani
  korak D6-tm-home  "\$TM_HOME ($TM_HOME)"                       d_tm_home 1
fi
if [ "$RAZINA" = do-nule ]; then
  korak D7-manifest "sve iz manifesta instalirano.json"         d_manifest 1
  korak D8-rc       "označeni retci u datotekama ljuske"        d_rc 1
  korak D9-kljuc    "redak tunela u authorized_keys"            d_kljuc 1
  korak D10-provjera "provjeri-cisto = 0 ostataka"              d_provjera 8
fi

ZAVRSENO=1
# odbijeni put iz manifesta ostaje na disku pa ga provjeri-cisto broji (8) — uzrok je brana (9)
KOD="$PRVI_PAD"; { [ "$KOD" = 0 ] || [ "$KOD" = 8 ]; } && [ "$N_ODBIJENO" -gt 0 ] && KOD=9
ISHOD=uspjeh; [ "$KOD" != 0 ] && ISHOD=pad; suho && ISHOD=suho
zapis_rezultat "$ISHOD" "$PRVI_PAD_KORAK" "$KOD" "razina $RAZINA: promijenjeno $N_PROMIJENJENO, preskočeno $N_PRESKOCENO, odbijeno $N_ODBIJENO"
echo
zapis_log "GOTOVO ($RAZINA): promijenjeno $N_PROMIJENJENO, preskočeno $N_PRESKOCENO$([ "$N_ODBIJENO" -gt 0 ] && echo ", ODBIJENO na brani $N_ODBIJENO")$(suho && echo ' (suho — ništa nije promijenjeno)')"
[ -n "${LOG_DIR:-}" ] && echo "log:    $LOG_DIR"
[ -n "${KOPIJA:-}" ] && ! suho && echo "kopija: $KOPIJA"
[ "$RAZINA" = do-nule ] && ! suho && echo "repozitorij $PAKET ostaje (ova skripta radi iz njega): ukloni ga sam — rm -rf $PAKET"
exit "$KOD"
