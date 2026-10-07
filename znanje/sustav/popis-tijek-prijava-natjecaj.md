# Tijek prijava-natjecaj — Prijava na natječaj

Tijek `prijava-natjecaj` zove se „Prijava na natječaj”. Čitanje uvjeta → koncept → proračun i obrasci → stroga evaluacija prije predaje.
Tijek je uključen (polje `enabled`). Globalni način rada svih tijekova određuje `config/workflow-gate.json` (vidi `prekidaci.md`).
Tijek je prenesen iz `izvorno napisan za katalog (nema zatečenog predloška)`.
Tijek se predlaže samo za posao težine najmanje 61; lakši posao ide jednom izvršitelju.
Polje `trazi_u` ima vrijednost naslov+opis.
Polje `prioritet` ima vrijednost 90.
Kad zadatak ovog tijeka završi, dojava korisniku nosi odjeljak „🧭 Tijek posla”: koraci, tko je radio te koje su vještine i alati stvarno korišteni (izmjereno iz transkripta). Tijek se mijenja u workflows.json ili oznakom `workflow:<id>` na nalogu.

## Koraci
Korak 1: Manda (uloga research) — Uvjeti poziva, rokovi, prihvatljivi troškovi, obavezni prilozi — svaki s izvorom. Treba: web i rag. Zamjena ako izvršitelj to ne može: Bez weba: koristi priloženu natječajnu dokumentaciju.
Korak 2: Kosjenka (uloga design) — Koncept projekta i logika intervencije; otvorena pitanja za naručitelja. Vještina: GrillWithDocs. Treba: dug-kontekst.
Korak 3: Jelena (uloga implement) — Ispuni obrasce i proračun; svaka brojka mora imati izvor. Treba: alate i pisanje.
Korak 4: Dora (uloga verify) — Evaluacija po kriterijima poziva, strogo — kao vanjski ocjenjivač. Treba: dug-kontekst.
Lanac agenata je Manda → Kosjenka → Jelena → Dora.

## Okidači
Okidači su regularni izrazi koje vrata tijeka (WorkflowGate) traže u naslovu i opisu zadatka; prvi tijek čiji uzorak pogodi dobiva zadatak, osim ako je zadatak lakši od praga. Koliko se puta tijek stvarno bira mjeri `tools/mjerila/workflow-odluke-mjera.ts`.
- `natječaj`
- `javni poziv`
- `prijav\w* projekt`
- `obrazac \d`
- `proračun projekta`
- `eu prijav`
