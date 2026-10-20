#!/usr/bin/env bash
# nadogradi.sh — nadogradnja TaskManagerAI NA ČVORU (Linux i macOS), plan Mac v3 K3.
#
#   bash scripts/nadogradi.sh --git origin [--grana main]                  # čvor s GitHubom (Mac)
#   bash scripts/nadogradi.sh --bundle ~/.tmp/paket.bundle --grana main --sha <sha>
#   ssh čvor 'bash -s -- --bundle …' < scripts/nadogradi.sh                # novi put i na starom stablu
#
# Opcije:
#   --git REMOTE | --bundle DATOTEKA   izvor koda (jedan od dva; bundle se nakon dohvata briše)
#   --grana G          grana izvora (zadano main) · --sha SHA  očekivani commit (inače vrh grane)
#   --u-granu G        ime lokalne grane na čvoru (zadano = --grana; brana stabla traži main)
#   --paket DIR        stablo paketa (zadano: mapa iz koje je skripta, ili ~/TaskManagerAI)
#   --usluga IME       usluga ploče (zadano regoc-taskmanager → systemd --user | hr.regoc.taskmanager)
#   --vrata N          vrata ploče za provjeru HTTP-a (zadano TM_PORT iz postavki čvora ili 17781)
#   --lokalno DAT      popis datoteka koje paket prati, a čvor drži drukčijima (zadano
#                      $TM_HOME/config/paket-lokalno.txt) — sačuvaju se i označe skip-worktree
#   --svjezina 'NAR'   dodatna provjera svježine koda; {PID} i {PAKET} se zamjenjuju; izlaz 0 = svjež
#   --bootcheck 'NAR'  dodatna provjera nakon podizanja; izlaz 0 = prolaz
#   --prevedi          jednokratno: stablo još nije git (git init pa isto)
#   --suho             dohvati izvor i javi STARO → NOVO i razliku; ništa ne mijenja
#
# Koraci (svaki ima redak u $TM_HOME/log/nadogradnja/<vrijeme>/koraci.jsonl, format P3.1):
#   N1 izvor · N2 stanje prije (MainPID, baza koju proces stvarno drži, broj zadataka) ·
#   N3 kopija ($TM_HOME/backup/nadogradnja/<vrijeme>: baza kroz sqlite .backup, lokalne datoteke;
#   čuva se zadnjih 5) · N4 checkout -f + vraćanje lokalnog stanja · N5 ovisnosti (samo kad se
#   bun.lock promijenio i registar odgovara u 5 s) · N6 brana radnog stabla · N7 restart kroz
#   upravitelj usluga · N8 provjere: novi MainPID ≠ stari, HTTP 200, proces drži ISTU bazu, svježina,
#   broj zadataka prije = poslije, git čist i na traženom commitu.
# Samostalna skripta (bez zapis.sh i buna za log): radi i kad je stablo na čvoru staro ili pokvareno.
# Izlaz: 0 „CVOR OK" · 1 „CVOR PAD" (provjere) · 2 uporaba · 10 nema stabla · 11 nije git ·
#        12 dohvat izvora · 13 kopija · 14 checkout · 16 brana stabla · 17 restart.
set -uo pipefail
export LC_NUMERIC=C LC_ALL="${LC_ALL:-C}"

IZVOR=""; REMOTE=""; BUNDLE=""; GRANA=main; U_GRANU=""; SHA=""; PAKET=""; USLUGA=regoc-taskmanager; VRATA=""
LOKALNO=""; SVJEZINA=""; BOOTCHECK=""; PREVEDI=0; SUHO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --git)       IZVOR=git; REMOTE="${2:-}"; shift ;;
    --bundle)    IZVOR=bundle; BUNDLE="${2:-}"; shift ;;
    --grana)     GRANA="${2:-}"; shift ;;
    --sha)       SHA="${2:-}"; shift ;;
    --u-granu)   U_GRANU="${2:-}"; shift ;;
    --paket)     PAKET="${2:-}"; shift ;;
    --usluga)    USLUGA="${2:-}"; shift ;;
    --vrata)     VRATA="${2:-}"; shift ;;
    --lokalno)   LOKALNO="${2:-}"; shift ;;
    --svjezina)  SVJEZINA="${2:-}"; shift ;;
    --bootcheck) BOOTCHECK="${2:-}"; shift ;;
    --prevedi)   PREVEDI=1 ;;
    --suho)      SUHO=1 ;;
    -h|--help)   sed -n '2,30p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null; exit 0 ;;
    *) echo "nepoznat argument: $1 (pomoć: bash scripts/nadogradi.sh --help)" >&2; exit 2 ;;
  esac
  shift
done
# ~/… iz omotača (ssh šalje argumente kao tekst, pa ih udaljena ljuska u navodnicima ne širi)
sirok() { case "$1" in "~") printf '%s' "$HOME" ;; "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;; *) printf '%s' "$1" ;; esac; }
PAKET="$(sirok "$PAKET")"; BUNDLE="$(sirok "$BUNDLE")"; LOKALNO="$(sirok "$LOKALNO")"
[ -n "$IZVOR" ] || { echo "nadogradi: zadaj izvor: --git REMOTE ili --bundle DATOTEKA" >&2; exit 2; }
[ "$IZVOR" = git ] && [ -z "$REMOTE" ] && { echo "nadogradi: --git traži ime remotea (npr. origin)" >&2; exit 2; }
[ "$IZVOR" = bundle ] && [ ! -f "$BUNDLE" ] && { echo "nadogradi: nema bundlea $BUNDLE" >&2; exit 2; }
U_GRANU="${U_GRANU:-$GRANA}"
printf '%s\n%s' "$GRANA" "$U_GRANU" | grep -Evq '^[A-Za-z0-9._/-]+$' && { echo "nadogradi: neispravno ime grane" >&2; exit 2; }
[ -z "$SHA" ] || printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{7,40}$' || { echo "nadogradi: --sha nije git sha" >&2; exit 2; }
if [ -z "$PAKET" ]; then
  izvor_skripte="${BASH_SOURCE[0]:-}"
  if [ -f "$izvor_skripte" ] && [ -d "$(dirname "$izvor_skripte")/../.git" ]; then PAKET="$(cd "$(dirname "$izvor_skripte")/.." && pwd -P)"
  else PAKET="$HOME/TaskManagerAI"; fi
fi
case "$(uname -s)" in Darwin) OS=darwin ;; *) OS=linux ;; esac
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
TM_HOME="${TM_HOME:-$HOME/.taskmanager}"
LOKALNO="${LOKALNO:-$TM_HOME/config/paket-lokalno.txt}"
if [ -z "$VRATA" ]; then
  VRATA="$(cat "$TM_HOME/config/instalacija.env" "$TM_HOME/config/postavke.env" "$PAKET/config/postavke.env" 2>/dev/null \
    | sed -n 's/^[[:space:]]*TM_PORT=\([0-9][0-9]*\)[[:space:]]*$/\1/p' | tail -1)"
  VRATA="${VRATA:-17781}"
fi
VRIJEME="$(date '+%Y%m%d-%H%M%S')"
OZNAKA="hr.regoc.${USLUGA#regoc-}"

# ── zapis (P3.1): koraci.jsonl, nadogradnja.log, nadogradnja-rezultat.json ─────
LOG_DIR=""
if [ "$SUHO" = 0 ]; then
  LOG_DIR="$TM_HOME/log/nadogradnja/$VRIJEME"; mkdir -p "$LOG_DIR" && chmod 700 "$TM_HOME/log/nadogradnja" "$LOG_DIR"
  ln -sfn "$VRIJEME" "$TM_HOME/log/nadogradnja/zadnji"
fi
js() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\t'/\\t}"; printf '"%s"' "$(printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037')"; }
zatamni() { sed -E -e 's/([A-Za-z0-9_]*(TOKEN|KEY|PASSWORD|SECRET)[A-Za-z0-9_]*)=[^[:space:]"]+/\1=«skriveno»/g' -e 's#://([^:/@[:space:]]+):[^@[:space:]]+@#://\1:«skriveno»@#g'; }
log() { local t; t="$(printf '%s\n' "$*" | zatamni)"; printf '%s\n' "$t"; [ -n "$LOG_DIR" ] && printf '%s\n' "$t" | sed "s/^/[$(date '+%H:%M:%S')] /" >> "$LOG_DIR/nadogradnja.log"; return 0; }
KORAK=""; T_KORAKA=0
korak() { KORAK="$1"; T_KORAKA="$(date +%s)"; log "── $1  $2"; }
gotov() {   # gotov IZLAZ [razlog]
  [ -n "$LOG_DIR" ] || return 0
  printf '{"t":%s,"korak":%s,"izlaz":%s,"trajanje_s":%s,"razlog":%s}\n' "$(js "$(date '+%Y-%m-%dT%H:%M:%S%z')")" "$(js "$KORAK")" "$1" \
    "$(( $(date +%s) - T_KORAKA ))" "$(js "${2:-}")" >> "$LOG_DIR/koraci.jsonl"
}
STARO=""; NOVI_PID=""; STARI_PID=""; PRIJE=""; POSLIJE=""
rezultat() {   # rezultat ISHOD IZLAZ PORUKA
  [ -n "$LOG_DIR" ] || return 0
  printf '{"ishod":%s,"korak":%s,"izlaz":%s,"poruka":%s,"staro":%s,"novo":%s,"stari_pid":%s,"novi_pid":%s,"zadataka_prije":%s,"zadataka_poslije":%s,"kopija":%s,"os":%s,"paket":%s}\n' \
    "$(js "$1")" "$(js "$KORAK")" "$2" "$(js "$3")" "$(js "$STARO")" "$(js "${SHA:0:12}")" "$(js "$STARI_PID")" "$(js "$NOVI_PID")" \
    "$(js "$PRIJE")" "$(js "$POSLIJE")" "$(js "${B:-}")" "$(js "$OS")" "$(js "$PAKET")" > "$LOG_DIR/nadogradnja-rezultat.json"
}
pad() { local k="$1"; shift; log "PREKID ($KORAK): $*"; gotov "$k" "$*"; rezultat pad "$k" "$*"; [ -n "$LOG_DIR" ] && echo "log: $LOG_DIR"; exit "$k"; }

# ── platforma: usluga, proces, baza ───────────────────────────────────────────
main_pid() {
  if [ "$OS" = linux ]; then systemctl --user show "$USLUGA" -p MainPID --value 2>/dev/null || echo 0
  else { launchctl print "system/$OZNAKA" 2>/dev/null || sudo -n launchctl print "system/$OZNAKA" 2>/dev/null; } \
         | awk '/^[[:space:]]*pid = [0-9]+/ { print $3; f = 1; exit } END { if (!f) print 0 }'; fi
}
restart_usluge() {
  if [ "$OS" = linux ]; then systemctl --user restart "$USLUGA"
  else sudo -n launchctl kickstart -k "system/$OZNAKA"; fi
}
okolina_varijabla() {   # okolina_varijabla PID IME → vrijednost iz okoline procesa (samo ta jedna)
  if [ -r "/proc/$1/environ" ]; then tr '\0' '\n' < "/proc/$1/environ" | sed -n "s/^$2=//p" | head -1
  else ps eww -o command= -p "$1" 2>/dev/null | tr ' ' '\n' | sed -n "s/^$2=//p" | head -1; fi
}
baza_procesa() {   # baza koju proces koristi: TM_DB iz okoline, inače zadana pod TM_HOME procesa
  local db th; db="$(okolina_varijabla "$1" TM_DB)"
  [ -n "$db" ] && { echo "$db"; return; }
  th="$(okolina_varijabla "$1" TM_HOME)"; echo "${th:-$TM_HOME}/data/tasks.db"
}
otvorene_baze() {
  if [ -d "/proc/$1/fd" ]; then ls -l "/proc/$1/fd" 2>/dev/null | grep -oE '/[^ ]+\.db$' | sort -u
  else lsof -p "$1" -Fn 2>/dev/null | sed -n 's/^n\(.*\.db\)$/\1/p' | sort -u; fi
}
pravi_put() { local d; d="$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)" && echo "$d/$(basename "$1")"; }
starost_s() { ps -o etime= -p "$1" 2>/dev/null | awk '{ n = split($1, a, /[-:]/); s = 0; m[1] = 1; m[2] = 60; m[3] = 3600; m[4] = 86400
  for (i = n; i >= 1; i--) s += a[i] * m[n - i + 1]; print s }'; }
broj_zadataka() {
  if command -v sqlite3 >/dev/null 2>&1; then sqlite3 "file:$1?mode=ro" 'select count(*) from tasks' 2>/dev/null
  else bun -e 'import { Database } from "bun:sqlite"; console.log(new Database(process.argv[1], { readonly: true }).query("select count(*) n from tasks").get().n)' "$1" 2>/dev/null; fi
}
kopija_baze() {   # kopija_baze IZVOR CILJ — dosljedna kopija i usred pisanja (WAL)
  if command -v sqlite3 >/dev/null 2>&1; then sqlite3 "$1" ".backup '$2'"
  else bun -e 'import { Database } from "bun:sqlite"; new Database(process.argv[1], { readonly: true }).exec(`VACUUM INTO '"'"'${process.argv[2]}'"'"'`)' "$1" "$2"; fi
}
s_rokom() { local s="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"
  else perl -e 'my $s=shift; my $p=fork; if(!$p){exec @ARGV or exit 127} $SIG{ALRM}=sub{kill "TERM",$p; waitpid $p,0; exit 124}; alarm $s; waitpid $p,0; exit($?>>8)' "$s" "$@"; fi; }
http_kod() { curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$VRATA/health" 2>/dev/null; }

log "TaskManagerAI — nadogradnja $PAKET ($OS, usluga $USLUGA, vrata $VRATA)$([ "$SUHO" = 1 ] && echo '  [SUHO]')"

# ── N1 izvor ──────────────────────────────────────────────────────────────────
korak N1-izvor "izvor koda ($IZVOR${REMOTE:+ $REMOTE}${BUNDLE:+ $BUNDLE}, grana $GRANA)"
cd "$PAKET" 2>/dev/null || pad 10 "nema stabla paketa $PAKET"
[ "$IZVOR" = bundle ] && trap 'rm -f "$BUNDLE"' EXIT
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  [ "$PREVEDI" = 1 ] || pad 11 "$PAKET nije git — pokreni jednom s --prevedi"
  [ "$SUHO" = 1 ] && pad 11 "$PAKET nije git (uz --suho ga ne pretvaram)"
  git init -q -b "$U_GRANU" && log "git init ($PAKET)"
fi
STARO_PUN="$(git rev-parse HEAD 2>/dev/null || echo bez-gita)"; STARO="${STARO_PUN:0:7}"
if [ "$IZVOR" = bundle ]; then
  git fetch -q "$BUNDLE" "$GRANA:refs/remotes/paket/$GRANA" --force || pad 12 "git fetch iz bundlea nije uspio"
else
  s_rokom 120 git fetch -q "$REMOTE" "$GRANA:refs/remotes/paket/$GRANA" --force || pad 12 "git fetch $REMOTE $GRANA nije uspio (mreža?)"
fi
CILJ_SHA="$(git rev-parse "paket/$GRANA")"
if [ -n "$SHA" ]; then [ "$CILJ_SHA" = "$(git rev-parse "$SHA^{commit}" 2>/dev/null)" ] || pad 12 "izvor ne nosi $SHA (vrh grane je ${CILJ_SHA:0:7})"; fi
SHA="$CILJ_SHA"
log "verzija: $STARO -> ${SHA:0:7}"
gotov 0 "$STARO -> ${SHA:0:7}"
if [ "$SUHO" = 1 ]; then
  if [ "$STARO_PUN" != bez-gita ] && git merge-base --is-ancestor HEAD "paket/$GRANA" 2>/dev/null; then git diff --stat HEAD "paket/$GRANA" | tail -1
  else echo "(nije predak izvora — checkout -f će zamijeniti radno stablo)"; fi
  echo "SUHO: ništa nije promijenjeno"; exit 0
fi
[ "$STARO_PUN" = "$SHA" ] && log "već na traženom commitu — samo restart i provjere"

# ── N2 stanje prije ───────────────────────────────────────────────────────────
korak N2-stanje "stanje prije: MainPID, baza procesa, broj zadataka"
STARI_PID="$(main_pid)"; STARI_PID="${STARI_PID:-0}"
if [ "$STARI_PID" != 0 ]; then DB="$(baza_procesa "$STARI_PID")"; else DB="$TM_HOME/data/tasks.db"; fi
DB="$(pravi_put "$DB" || echo "$DB")"
[ -f "$DB" ] || pad 13 "baza $DB ne postoji (usluga $USLUGA: MainPID $STARI_PID)"
PRIJE="$(broj_zadataka "$DB")"
[ -n "$PRIJE" ] || pad 13 "ne mogu prebrojati zadatke u $DB"
log "MainPID $STARI_PID · baza $DB · zadataka $PRIJE"
gotov 0 "MainPID $STARI_PID, zadataka $PRIJE"

# ── N3 kopija ─────────────────────────────────────────────────────────────────
korak N3-kopija "kopija baze i lokalnog stanja"
B="$TM_HOME/backup/nadogradnja/$VRIJEME"; mkdir -p "$B" && chmod 700 "$TM_HOME/backup/nadogradnja" "$B"
kopija_baze "$DB" "$B/$(basename "$DB")" || pad 13 "kopija baze nije uspjela — prekid"
[ -e "$(dirname "$DB")/messages.db" ] && { kopija_baze "$(dirname "$DB")/messages.db" "$B/messages.db" || pad 13 "kopija messages.db nije uspjela"; }
cp "$HOME/.config/systemd/user/$USLUGA.service" "/Library/LaunchDaemons/$OZNAKA.plist" "$B/" 2>/dev/null
echo "$STARO_PUN" > "$B/verzija_prije.txt"
# sve što nije node_modules/.git, a nije u ciljnom commitu = lokalno stanje ili stari kod → u kopiju
git ls-tree -r --name-only "paket/$GRANA" | sort > "$B/.cilj"
find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -print | sed 's|^\./||' | sort | comm -23 - "$B/.cilj" > "$B/izvan_paketa.txt"
[ -f "$LOKALNO" ] && grep -v '^#' "$LOKALNO" | sed '/^$/d' >> "$B/izvan_paketa.txt"
tar czf "$B/lokalno.tgz" -T "$B/izvan_paketa.txt" 2>/dev/null
ls -1dt "$TM_HOME"/backup/nadogradnja/*/ 2>/dev/null | tail -n +6 | while IFS= read -r d; do rm -rf "$d"; done
log "kopija: $B ($(wc -l < "$B/izvan_paketa.txt" | tr -d ' ') datoteka izvan paketa)"
gotov 0 "$B"

# ── N4 checkout ───────────────────────────────────────────────────────────────
korak N4-checkout "checkout ${SHA:0:7} kao $U_GRANU i lokalno stanje"
LOCK_PRIJE="$(cksum < bun.lock 2>/dev/null)"
git ls-files -v | awk '/^S /{print $2}' | while IFS= read -r f; do git update-index --no-skip-worktree "$f"; done
git checkout -q -f -B "$U_GRANU" "paket/$GRANA" || pad 14 "checkout nije uspio — vrati iz $B"
# git-ignorirano lokalno stanje koje je checkout obrisao (bilo praćeno u staroj povijesti) — postojeće se ne prepisuje
tar xzkf "$B/lokalno.tgz" 2>/dev/null
if [ -f "$LOKALNO" ]; then
  while IFS= read -r f; do
    { [ -z "$f" ] || [ "${f:0:1}" = "#" ]; } && continue
    tar xzf "$B/lokalno.tgz" "$f" 2>/dev/null && git update-index --skip-worktree "$f" && log "lokalno zadržano: $f"
  done < "$LOKALNO"
fi
# ono što nije ignorirano, a nije u paketu = stari kod koji je paket izbacio (kopija je u $B)
OSTACI="$(git clean -nd | wc -l | tr -d ' ')"; [ "$OSTACI" -gt 0 ] && { git clean -fdq; log "uklonjeno ostataka starog koda: $OSTACI (vidi $B/izvan_paketa.txt)"; }
if [ -z "$(git status --porcelain)" ]; then log "git status: čist"; else log "git status NIJE čist:"; log "$(git status --short | head)"; fi
gotov 0 "HEAD $(git rev-parse --short HEAD)"

# ── N5 ovisnosti ──────────────────────────────────────────────────────────────
korak N5-ovisnosti "ovisnosti (bun.lock, sposobnosti)"
REGISTAR=0; curl -s -m 5 -o /dev/null https://registry.npmjs.org/ && REGISTAR=1
if [ "$(cksum < bun.lock 2>/dev/null)" != "$LOCK_PRIJE" ]; then
  if [ "$REGISTAR" = 1 ]; then
    s_rokom 120 bun install --frozen-lockfile >/dev/null 2>&1 && log "bun install: ok" || log "UPOZORENJE: bun install nije uspio — ostaje postojeći node_modules"
  else log "UPOZORENJE: bun.lock promijenjen, registar nedostupan — ostaje postojeći node_modules"; fi
else log "bun.lock isti — node_modules se ne dira"; fi
if [ -f scripts/sposobnosti.ts ]; then
  if [ "$REGISTAR" = 1 ]; then s_rokom 200 bun scripts/sposobnosti.ts --instaliraj 2>&1 | sed 's/^/sposobnosti: /' | while IFS= read -r r; do log "$r"; done
  else s_rokom 30 bun scripts/sposobnosti.ts 2>&1 | sed 's/^/sposobnosti (bez registra): /' | while IFS= read -r r; do log "$r"; done; fi
fi
gotov 0 "registar $([ "$REGISTAR" = 1 ] && echo dostupan || echo nedostupan)"

# ── N6 brana radnog stabla ────────────────────────────────────────────────────
korak N6-brana "brana radnog stabla ploče"
if [ -f scripts/brana-radnog-stabla.ts ]; then
  bun scripts/brana-radnog-stabla.ts "$PAKET" --ugradi 2>&1 | while IFS= read -r r; do log "$r"; done
  [ "${PIPESTATUS[0]}" = 0 ] || pad 16 "brana radnog stabla — restart NIJE izveden (vrati iz $B)"
  gotov 0 "brana prošla"
else gotov 0 "paket nema brane radnog stabla"; fi

# ── N7 restart ────────────────────────────────────────────────────────────────
korak N7-restart "restart usluge $USLUGA"
T_RESTART="$(date +%s)"
restart_usluge 2>&1 | while IFS= read -r r; do log "$r"; done
if [ "$STARI_PID" != 0 ] && kill -0 "$STARI_PID" 2>/dev/null && ps -o args= -p "$STARI_PID" 2>/dev/null | grep -q TaskWebUI; then
  sleep 3
  kill -0 "$STARI_PID" 2>/dev/null && { log "stari PID $STARI_PID preživio restart -> kill -9"; kill -9 "$STARI_PID"; }
fi
NOVI_PID=0; HTTP=000
for i in $(seq 1 45); do
  NOVI_PID="$(main_pid)"; HTTP="$(http_kod)"
  [ "$NOVI_PID" != 0 ] && [ "$NOVI_PID" != "$STARI_PID" ] && [ "$HTTP" = 200 ] && break
  sleep 2
done
log "MainPID: $STARI_PID -> $NOVI_PID  start $(ps -o lstart= -p "$NOVI_PID" 2>/dev/null)  HTTP $HTTP"
{ [ "$NOVI_PID" != 0 ] && [ "$NOVI_PID" != "$STARI_PID" ]; } || pad 17 "usluga se nije podigla s novim procesom (MainPID $STARI_PID -> $NOVI_PID, HTTP $HTTP) — vrati: git checkout -f $STARO, pa restart"
gotov 0 "MainPID $STARI_PID -> $NOVI_PID"

# ── N8 provjere ───────────────────────────────────────────────────────────────
korak N8-provjere "provjere nakon podizanja"
OK=1; ZASTO=""
ne() { OK=0; ZASTO="${ZASTO:+$ZASTO; }$*"; log "✗ $*"; }
[ "$HTTP" = 200 ] && log "✓ HTTP $HTTP (127.0.0.1:$VRATA/health)" || ne "HTTP $HTTP na 127.0.0.1:$VRATA/health"
DB_NOVA="$(pravi_put "$(baza_procesa "$NOVI_PID")" || true)"
[ "$DB_NOVA" = "$DB" ] && log "✓ novi proces koristi istu bazu ($DB)" || ne "novi proces koristi $DB_NOVA, a stari je koristio $DB"
OTVORENE="$(otvorene_baze "$NOVI_PID" | while IFS= read -r f; do pravi_put "$f"; done | tr '\n' ' ')"
log "otvorene baze: ${OTVORENE:-—}"
case " $OTVORENE " in *" $DB "*) log "✓ proces drži $DB" ;; *) ne "proces ne drži $DB" ;; esac
STAROST="$(starost_s "$NOVI_PID")"
if [ -n "$STAROST" ] && [ "$STAROST" -le $(( $(date +%s) - T_RESTART + 2 )) ]; then log "✓ svjež: proces star ${STAROST} s, pokrenut nakon checkouta"
else ne "proces $NOVI_PID star ${STAROST:-?} s — stariji od restarta"; fi
if [ -n "$SVJEZINA" ]; then
  n="${SVJEZINA//\{PID\}/$NOVI_PID}"; n="${n//\{PAKET\}/$PAKET}"
  bash -c "$n" 2>&1 | tail -3 | while IFS= read -r r; do log "  $r"; done
  k="${PIPESTATUS[0]}"; [ "$k" = 0 ] && log "✓ provjera svježine: izlaz 0" || ne "provjera svježine: izlaz $k"
fi
if [ -n "$BOOTCHECK" ]; then
  bash -c "$BOOTCHECK" 2>&1 | grep -E 'SUD|VERDIKT|PASS|FAIL' | tail -3 | while IFS= read -r r; do log "  $r"; done
  k="${PIPESTATUS[0]}"; [ "$k" = 0 ] && log "✓ bootcheck: izlaz 0" || ne "bootcheck: izlaz $k"
fi
POSLIJE="$(broj_zadataka "$DB")"
[ "$PRIJE" = "$POSLIJE" ] && log "✓ zadataka: prije $PRIJE, poslije $POSLIJE" || ne "zadataka: prije $PRIJE, poslije ${POSLIJE:-?}"
[ "$(git rev-parse HEAD)" = "$SHA" ] && log "✓ HEAD ${SHA:0:7}" || ne "HEAD $(git rev-parse --short HEAD) ≠ ${SHA:0:7}"
[ -z "$(git status --porcelain)" ] || ne "git status nije čist"
if [ "$OK" = 1 ]; then gotov 0 "sve provjere prošle"; rezultat uspjeh 0 "$STARO -> ${SHA:0:7}, MainPID $STARI_PID -> $NOVI_PID, zadataka $PRIJE = $POSLIJE"
  log "log: $LOG_DIR"; echo "CVOR OK"; exit 0; fi
gotov 1 "$ZASTO"; rezultat pad 1 "$ZASTO"
log "log: $LOG_DIR · kopija: $B (vrati: git -C $PAKET checkout -f $STARO, baza iz $B)"
echo "CVOR PAD"; exit 1
