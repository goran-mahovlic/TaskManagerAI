# Tijek istrazi-planiraj-izvedi — Istraži → isplaniraj → zadatci → izvedba

Tijek `istrazi-planiraj-izvedi` zove se „Istraži → isplaniraj → zadatci → izvedba”. Posao koji se prije izvedbe mora istražiti: nalazi → arhitektura i razlaganje → zadatci na ploči → višeagentska izvedba s provjerom.
Tijek je uključen (polje `enabled`). Globalni način rada svih tijekova određuje `config/workflow-gate.json` (vidi `prekidaci.md`).
Tijek je prenesen iz `~/.claude/skills/Workflows/ResearchPlanAgenticTaskmanagerWork.md`.
Tijek se predlaže samo za posao težine najmanje 61; lakši posao ide jednom izvršitelju.
Polje `trazi_u` ima vrijednost naslov.
Polje `prioritet` ima vrijednost 70.
Kad zadatak ovog tijeka završi, dojava korisniku nosi odjeljak „🧭 Tijek posla”: koraci, tko je radio te koje su vještine i alati stvarno korišteni (izmjereno iz transkripta). Tijek se mijenja u workflows.json ili oznakom `workflow:<id>` na nalogu.

## Koraci
Korak 1: Manda (uloga research) — Istraži prostor problema: RAG, web, dokumentacija, dodirne točke u postojećem kodu. Izlaz: nalazi s izvorima, ograničenja i preporučen pristup. Vještina: Research. Treba: web i rag. Zamjena ako izvršitelj to ne može: Bez weba: pretraži samo RAG i postojeće spise; izostanak izvora navedi izrijekom.
Korak 2: Kosjenka (uloga plan) — Arhitektura rješenja (sučelja, tok podataka) i razlaganje na atomarne zadatke: izvršitelj, ovisnosti, kritični put, procjena. Za E3+ i ISA. Vještina: GrillWithDocs. Treba: dug-kontekst. Zamjena ako izvršitelj to ne može: Bez GrillWithDocs: plan u pet natuknica — koraci, tko ih radi, čime je svaki dokazan.
Korak 3: REGOČ (uloga taskmanager) — Otvori zadatke na ploči (POST /api/tasks, port 17781): opis s prihvatnim kriterijem, izvršitelj, prioritet, projectId, blockedBy lanac, oznake. Provjeri da su vidljivi. Treba: alate. Zamjena ako izvršitelj to ne može: Bez pristupa ploči: ispiši popis zadataka u istom obliku i navedi da nisu otvoreni.
Korak 4: Jelena (uloga work) — Izvedba zadataka po prioritetu i ovisnostima; svaki korak prolazi vrata provjere i vraća DONE/BLOCKED/NEEDS_CONTEXT. Potjeh provjerava dovršeno. Treba: alate i pisanje. Zamjena ako izvršitelj to ne može: Bez alata: opiši izmjenu i naredbu koja je dokazuje; izvedbu preuzima jači izvršitelj.
Lanac agenata je Manda → Kosjenka → REGOČ → Jelena.

## Okidači
Okidači su regularni izrazi koje vrata tijeka (WorkflowGate) traže u naslovu i opisu zadatka; prvi tijek čiji uzorak pogodi dobiva zadatak, osim ako je zadatak lakši od praga. Koliko se puta tijek stvarno bira mjeri `tools/mjerila/workflow-odluke-mjera.ts`.
- `(istraž|prouč)[a-zćčšžđ]* .{0,60}(pa|te|i) (implementiraj|izvedi|napravi|ugradi|prepravi)`
- `(implementiraj|izvedi|napravi) .{0,60}(nakon|po) (istraživanj|analiz)`
- `od istraživanja do (izvedbe|implementacije)`
- `istraži,? (pa )?(isplaniraj|planiraj)`
- `razlož[a-zćčšžđ]* .{0,40}na (zadatke|podzadatke)`
- `(razradi|razloži) (zahtjev|plan|specifikaciju) .{0,40}u zadatke`
