# Tijek security-audit — Sigurnosna revizija

Tijek `security-audit` zove se „Sigurnosna revizija”. Revizija → provjera nalaza → preporuke.
Tijek je uključen (polje `enabled`). Globalni način rada svih tijekova određuje `config/workflow-gate.json` (vidi `prekidaci.md`).
Tijek je prenesen iz `REGOČ TeamWorkflow.ts (security-audit)`.
Tijek se predlaže samo za posao težine najmanje 36; lakši posao ide jednom izvršitelju.
Polje `trazi_u` ima vrijednost naslov.
Polje `prioritet` ima vrijednost 50.
Kad zadatak ovog tijeka završi, dojava korisniku nosi odjeljak „🧭 Tijek posla”: koraci, tko je radio te koje su vještine i alati stvarno korišteni (izmjereno iz transkripta). Tijek se mijenja u workflows.json ili oznakom `workflow:<id>` na nalogu.

## Koraci
Korak 1: Malik (uloga audit) — Pregled koda i površine napada; svaki nalaz s dokazom. Vještina: RedTeam. Treba: alate. Zamjena ako izvršitelj to ne može: Bez RedTeama: prođi popis provjera i za svaku napiši nalaz ili „uredno”.
Korak 2: Potjeh (uloga verify) — Provjeri nalaze — koji su stvarni, koji su lažna uzbuna. Treba: alate.
Korak 3: Kosjenka (uloga recommend) — Preporuke po prioritetu, s procjenom truda. Treba: dug-kontekst.
Lanac agenata je Malik → Potjeh → Kosjenka.

## Okidači
Okidači su regularni izrazi koje vrata tijeka (WorkflowGate) traže u naslovu i opisu zadatka; prvi tijek čiji uzorak pogodi dobiva zadatak, osim ako je zadatak lakši od praga. Koliko se puta tijek stvarno bira mjeri `tools/mjerila/workflow-odluke-mjera.ts`.
- `sigurnos`
- `ranjivost`
- `napad`
- `audit`
- `penetracij`
- `tajne? u kodu`
- `ovlasti`
