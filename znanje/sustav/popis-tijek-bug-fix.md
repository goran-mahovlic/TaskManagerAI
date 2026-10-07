# Tijek bug-fix — Otklanjanje kvara

Tijek `bug-fix` zove se „Otklanjanje kvara”. Dijagnoza uzroka → popravak s regresijskim testom → provjera.
Tijek je uključen (polje `enabled`). Globalni način rada svih tijekova određuje `config/workflow-gate.json` (vidi `prekidaci.md`).
Tijek je prenesen iz `REGOČ TeamWorkflow.ts (bug-fix) + faze ANALIZA i DOKUMENTACIJA iz REGOČ workflows/BugFixWorkflow.ts`.
Tijek se predlaže samo za posao težine najmanje 16; lakši posao ide jednom izvršitelju.
Polje `trazi_u` ima vrijednost naslov.
Polje `prioritet` ima vrijednost 20.
Kad zadatak ovog tijeka završi, dojava korisniku nosi odjeljak „🧭 Tijek posla”: koraci, tko je radio te koje su vještine i alati stvarno korišteni (izmjereno iz transkripta). Tijek se mijenja u workflows.json ili oznakom `workflow:<id>` na nalogu.

## Koraci
Korak 1: Jelena (uloga fix) — Prije popravka utvrdi KORIJENSKI uzrok i zapiši ga (ADR ako mijenja odluku); Reproduciraj, izoliraj, postavi hipotezu, dokaži je, popravi, dodaj regresijski test. Vještina: DiagnosingBugs. Treba: alate i pisanje. Zamjena ako izvršitelj to ne može: Bez DiagnosingBugs: opiši kako se kvar ponavlja, što si promijenio i koja naredba to dokazuje.
Korak 2: Potjeh (uloga test) — Potvrdi da je kvar nestao i da ništa drugo nije puklo. Treba: alate.
Korak 3: Malik (uloga review) — Provjeri da popravak nije otvorio sigurnosnu rupu. Na kraju zapiši lekciju u RAG (uzrok, popravak, čime je dokazan) — inače se nalaz gubi do sljedećeg spawna. Treba: alate.
Lanac agenata je Jelena → Potjeh → Malik.

## Okidači
Okidači su regularni izrazi koje vrata tijeka (WorkflowGate) traže u naslovu i opisu zadatka; prvi tijek čiji uzorak pogodi dobiva zadatak, osim ako je zadatak lakši od praga. Koliko se puta tijek stvarno bira mjeri `tools/mjerila/workflow-odluke-mjera.ts`.
- `(servis|daemon|test|build|aplikacij|stranic|skript|api|ploč|prijav|sučelj|gumb|modul|poslužitelj|server|baz|izvoz|uvoz|ekran)\S* .{0,30}(ne radi|pada|puca)`
- `puca`
- `\bbug\b`
- `kvar`
- `regresij`
- `greška u`
- `pogreška u`
- `zašto .{0,40}(servis|daemon|test|build|aplikacij|stranic|skript|api|ploč|prijav|sučelj|gumb|modul|poslužitelj|server|baz|izvoz|uvoz|ekran)\S* .{0,30}(ne radi|pada|puca)`

## Isključenja
Uzorak iz ovog popisa poništava pogodak okidača ovog tijeka (traži se u istom tekstu kao okidači).
- `(\bQA\b|provjer|testiraj|regresijsk[a-zčćšžđ]* test|ako .{0,30}(pada|ne radi))`
