# rc.sh — retci koje instalacija dodaje u TUĐE datoteke ljuske (~/.zshrc, ~/.bashrc…), plan P3.4.
# Uključuju ga scripts/install.sh i scripts/deinstaliraj.sh (`.`); bash 3.2, bez buna i Pythona.
#
# Službene instalacijske skripte (bun, Claude CLI) same dopisuju PATH u datoteku ljuske i ne
# označe što su dodale. Zato instalacija prije njih snimi te datoteke (`rc_snimi`), a poslije
# (`rc_oznaci`) dodani dio omota oznakama:
#   # >>> TaskManagerAI >>> (<opis>)
#   …retci koje je dodao instalator…
#   # <<< TaskManagerAI <<<
# `deinstaliraj.sh --do-nule` briše SAMO retke između oznaka (`rc_ukloni`); ostatak datoteke
# je korisnikov i ostaje bajt-za-bajt isti.

RC_OZNAKA_POCETAK='# >>> TaskManagerAI >>>'
RC_OZNAKA_KRAJ='# <<< TaskManagerAI <<<'
rc_datoteke() {
  printf '%s\n' "$HOME/.zprofile" "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.config/fish/config.fish"
}

# rc_snimi MAPA — kopija svake postojeće datoteke ljuske (i popis onih kojih nema)
rc_snimi() {
  local mapa="$1" f i=0
  rm -rf "$mapa"; mkdir -p "$mapa"
  while IFS= read -r f; do
    i=$((i + 1))
    if [ -f "$f" ]; then cp -p "$f" "$mapa/$i"; else : > "$mapa/$i.nema"; fi
  done < <(rc_datoteke)
}

# rc_oznaci MAPA OPIS — omota ono što je dopisano od snimke; ispisuje „RC-NOVA <put>" za
# datoteku koju je instalator tek stvorio (ide u manifest kao vrsta rc-nova) i „RC <put>"
# za postojeću. Instalator koji je mijenjao SREDINU datoteke se ne dira: „RC-UPOZORENJE <put>".
rc_oznaci() {
  local mapa="$1" opis="$2" f i=0 stara velicina dodano
  while IFS= read -r f; do
    i=$((i + 1))
    [ -f "$f" ] || continue
    if [ -e "$mapa/$i.nema" ]; then stara=""; velicina=0
    else
      stara="$mapa/$i"
      cmp -s "$stara" "$f" && continue
      velicina="$(wc -c < "$stara" | tr -d ' ')"
      if ! head -c "$velicina" "$f" | cmp -s - "$stara"; then echo "RC-UPOZORENJE $f"; continue; fi
    fi
    dodano="$(tail -c +"$((velicina + 1))" "$f")"
    printf '%s' "$dodano" | grep -q '[^[:space:]]' || continue
    {
      [ -n "$stara" ] && cat "$stara"
      printf '%s (%s)\n' "$RC_OZNAKA_POCETAK" "$opis"
      printf '%s\n' "$dodano" | sed '/./,$!d'
      printf '%s\n' "$RC_OZNAKA_KRAJ"
    } > "$f.tm-novo" && cat "$f.tm-novo" > "$f" && rm -f "$f.tm-novo"
    if [ -z "$stara" ]; then echo "RC-NOVA $f"; else echo "RC $f"; fi
  done < <(rc_datoteke)
  rm -rf "$mapa"
}

# rc_ukloni DATOTEKA — briše blokove između oznaka; izlaz 0 kad je nešto uklonjeno, 1 kad nije
rc_ukloni() {
  local f="$1"
  [ -f "$f" ] && grep -q "^$RC_OZNAKA_POCETAK" "$f" || return 1
  awk -v p="$RC_OZNAKA_POCETAK" -v k="$RC_OZNAKA_KRAJ" '
    index($0, p) == 1 { u = 1; next }
    u && index($0, k) == 1 { u = 0; next }
    !u { print }' "$f" > "$f.tm-novo" && cat "$f.tm-novo" > "$f" && rm -f "$f.tm-novo"
}
