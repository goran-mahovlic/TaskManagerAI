# Tijek dorada-isporuke — Dorada već isporučenog

Tijek `dorada-isporuke` zove se „Dorada već isporučenog”. Primjedbe na nešto što je već predano (nova inačica, ispravak izgleda, „isto kao v3, ali…”). CLAUDE.md pravilo 25: dorada dobiva vlastiti zadatak prije rada. Radi je izvorni izvršitelj, ne ispočetka.
Tijek je uključen (polje `enabled`). Globalni način rada svih tijekova određuje `config/workflow-gate.json` (vidi `prekidaci.md`).
Tijek je prenesen iz `izvorno napisan za katalog`.
Tijek se predlaže samo za posao težine najmanje 0; lakši posao ide jednom izvršitelju.
Polje `trazi_u` ima vrijednost naslov.
Polje `prioritet` ima vrijednost 95.
Kad zadatak ovog tijeka završi, dojava korisniku nosi odjeljak „🧭 Tijek posla”: koraci, tko je radio te koje su vještine i alati stvarno korišteni (izmjereno iz transkripta). Tijek se mijenja u workflows.json ili oznakom `workflow:<id>` na nalogu.

## Koraci
Korak 1: izvorni izvršitelj (uloga dorada) — Primijeni SAMO primjedbe na postojeću isporuku (izvorni zadatak je u oznaci `dorada-od:<ID>`); ne radi ispočetka — kopiraj i izmijeni. Izlaz: nova inačica s oznakom verzije i popis što je promijenjeno. Treba: alate i pisanje. Zamjena ako izvršitelj to ne može: Ako izvorni izvršitelj nije dostupan: izvršitelj koji ima istu vještinu kao izvorni korak (polje `vjestina` izvornog zadatka). Izvršitelj je onaj koji je radio zadatak iz oznake `dorada-od:<ID>`.
Korak 2: Potjeh (uloga qa) — Provjeri SAMO primjedbe i regresiju onoga što je u prošloj inačici bilo dobro; otvori isporuku u DRUGOM pregledniku/pregledniku PDF-a od onoga u kojem je izrađena (Chromium → Firefox/pdf.js). Izlaz: tablica primjedba | stanje | dokaz (snimka/putanja). Vještina: WebappTesting. Treba: alate. Zamjena ako izvršitelj to ne može: Bez preglednika: pdftotext + pdfinfo i usporedba s prošlom inačicom; to izrijekom reci u rezultatu.
Korak 3: REGOČ (uloga isporuka) — Sustav (ReportBackTask, bez modela) šalje novu inačicu i TIJEK POSLA u isti chat (oznaka `chat:<id>`). Ovaj korak ne radi model: obavlja ga mehanizam `report-back` bez spawna agenta.
Lanac agenata je izvorni izvršitelj → Potjeh → REGOČ.

## Okidači
Okidači su regularni izrazi koje vrata tijeka (WorkflowGate) traže u naslovu i opisu zadatka; prvi tijek čiji uzorak pogodi dobiva zadatak, osim ako je zadatak lakši od praga. Koliko se puta tijek stvarno bira mjeri `tools/mjerila/workflow-odluke-mjera.ts`.
- `(dorad|ispravi|ispravak|promijeni|promjen|popravi|popravak|izmijeni|izmjen)\S* .{0,40}(dokument|životopis|cv\b|ponud|pdf|docx|pptx|dizajn|isporuk|verzij|inačic|prezentacij|letak|plakat|izvještaj|predložak)`
- `(dokument|životopis|cv\b|ponud|pdf|docx|pptx|letak|plakat|prezentacij|izvještaj)\S* .{0,60}(dorad|ispravak|popravak|izmjen|promjen)`
- `(nova|druga|sljedeća) (verzija|inačica)`
- `^(dokument|životopis|cv\b|ponuda|prezentacija|letak|plakat|izvještaj|brošura)\S* v\d`
- `(identičn|isti|ista|isto|kao)\S* .{0,15}\bv\d+\b`
- `uskla\S* .{0,40}(s|sa) \bv\d+\b`
- `editabiln\S* .{0,20}(docx|pptx|dokument|životopis|cv\b)`

## Isključenja
Uzorak iz ovog popisa poništava pogodak okidača ovog tijeka (traži se u istom tekstu kao okidači).
- `(ne radi|\bpada\b(?! (u|na) (drugi|novi|sljedeći|idući|drugu|novu|sljedeću|iduću) (red|stranic))|puca|kvar|\bbug\b|greška u|pogreška u)`
- `(\bQA\b|provjer)`
- `(daemon|\bapi\b|servis|skript|modul|klijent|poslužitelj|server|\bbaz[aeiu]\b|shem|aplikacij|ploč[aeiu]\b|\.ts\b|\bkod\b)`
 (Potjeh): (1) tipografski „pada u drugi red / na drugu stranicu” je dorada, ne kvar; (2) softverski predmet (daemon, API, shema, modul…) isključuje doradu — inače „nova verzija”, „kao v4” i „uskladi s v2” granaju softver u dokumentni tijek s prioritetom 95. Proba: bun docs/prijedlozi/tijekovi-5158-qa-rubovi.ts.
