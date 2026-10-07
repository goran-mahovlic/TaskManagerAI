# Tijek novi-projekt — Otvaranje novog projekta

Tijek `novi-projekt` zove se „Otvaranje novog projekta”. <!--u:nextcloud-->Novi projekt na jednom mjestu: mapa i dijeljenje na Nextcloudu, zapis projekta na ploči, prvi zadatci i specifikacija.<!--/u-->
Tijek je uključen (polje `enabled`). Globalni način rada svih tijekova određuje `config/workflow-gate.json` (vidi `prekidaci.md`).
Tijek je prenesen iz `REGOČ workflows/CreateProjectWorkflow.ts (v1.0.0)`.
Tijek se predlaže samo za posao težine najmanje 0; lakši posao ide jednom izvršitelju.
Polje `trazi_u` ima vrijednost naslov.
Polje `prioritet` ima vrijednost 80.
Kad zadatak ovog tijeka završi, dojava korisniku nosi odjeljak „🧭 Tijek posla”: koraci, tko je radio te koje su vještine i alati stvarno korišteni (izmjereno iz transkripta). Tijek se mijenja u workflows.json ili oznakom `workflow:<id>` na nalogu.

## Koraci
Korak 1: Kosjenka (uloga opseg) — Utvrdi ime, opis, prioritet (1–5), vodećeg agenta, oznake i s kim se mapa dijeli; provjeri da projekt s tim imenom već ne postoji. Treba: alate. Zamjena ako izvršitelj to ne može: Bez alata: ispiši istih šest polja i zatraži potvrdu prije otvaranja.
<!--u:nextcloud-->Korak 2: REGOČ (uloga izvedba) — Pokreni `bun <orkestrator>/workflows/CreateProjectWorkflow.ts "<ime>" --description … --priority … --lead … --tags …` — mapa /PROJEKTI/<ime> na Nextcloudu, dijeljenje, zapis projekta i metapodatci (folder path, share url).<!--/u--> Provjeri povratni projectId. Treba: alate, web i pisanje. <!--u:nextcloud-->Zamjena ako izvršitelj to ne može: Bez Nextclouda: otvori projekt preko POST /api/projects i zapiši izrijekom da mapa nije stvorena.<!--/u-->
Korak 3: Kosjenka (uloga pokretanje) — Otvori prve zadatke s tim `projectId` i zapiši specifikaciju (SSOT) te prvi ADR ako projekt nosi arhitektonsku odluku. Treba: alate i pisanje. Zamjena ako izvršitelj to ne može: Bez alata: nabroji prve zadatke i gdje specifikacija treba stajati.
Lanac agenata je Kosjenka → REGOČ → Kosjenka.

## Okidači
Okidači su regularni izrazi koje vrata tijeka (WorkflowGate) traže u naslovu i opisu zadatka; prvi tijek čiji uzorak pogodi dobiva zadatak, osim ako je zadatak lakši od praga. Koliko se puta tijek stvarno bira mjeri `tools/mjerila/workflow-odluke-mjera.ts`.
- `(otvori|kreiraj|napravi|pokreni|osnuj) (mi )?(novi )?projekt`
- `novi projekt (za|na|:)`
- `zavedi projekt`
