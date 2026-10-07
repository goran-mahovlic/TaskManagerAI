# Tijek implement-feature — Izrada značajke

Tijek `implement-feature` zove se „Izrada značajke”. Puni put nove značajke: dizajn → izvedba → provjera → sigurnosni pregled.
Tijek je uključen (polje `enabled`). Globalni način rada svih tijekova određuje `config/workflow-gate.json` (vidi `prekidaci.md`).
Tijek je prenesen iz `REGOČ TeamWorkflow.ts (implement-feature)`.
Tijek se predlaže samo za posao težine najmanje 36; lakši posao ide jednom izvršitelju.
Polje `trazi_u` ima vrijednost naslov.
Polje `prioritet` ima vrijednost 40.
Kad zadatak ovog tijeka završi, dojava korisniku nosi odjeljak „🧭 Tijek posla”: koraci, tko je radio te koje su vještine i alati stvarno korišteni (izmjereno iz transkripta). Tijek se mijenja u workflows.json ili oznakom `workflow:<id>` na nalogu.

## Koraci
Korak 1: Kosjenka (uloga design) — Zaoštri zahtjev, zapiši ADR i rječnik pojmova; izlaz: plan s ulazima i izlazima. Vještina: GrillWithDocs. Treba: dug-kontekst. Zamjena ako izvršitelj to ne može: Bez GrillWithDocs: napiši plan u pet natuknica — što je gotovo, što je izvan opsega, po čemu se zna da je gotovo.
Korak 2: Jelena (uloga implement) — Izvedba po planu, test prije koda; git grana zadatak/TASK-####, commit po koraku. Vještina: TDD. Treba: alate i pisanje. Zamjena ako izvršitelj to ne može: Bez TDD-a: napravi izmjenu i uz nju bar jednu naredbu koja dokazuje da radi.
Korak 3: Potjeh (uloga test) — Neovisna provjera: pokreni, izmjeri, prijavi što ne radi. Treba: alate.
Korak 4: Malik (uloga review) — Sigurnosni pregled izmjena prije spajanja. Treba: alate.
Lanac agenata je Kosjenka → Jelena → Potjeh → Malik.

## Okidači
Okidači su regularni izrazi koje vrata tijeka (WorkflowGate) traže u naslovu i opisu zadatka; prvi tijek čiji uzorak pogodi dobiva zadatak, osim ako je zadatak lakši od praga. Koliko se puta tijek stvarno bira mjeri `tools/mjerila/workflow-odluke-mjera.ts`.
- `dodaj (značajku|mogućnost)`
- `implementiraj`
- `nova značajka`
- `napravi (modul|sučelje|ekran)`
- `prepravi arhitekturu`
