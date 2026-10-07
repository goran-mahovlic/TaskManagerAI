# Tijek izrada-dokumenta — Izrada dokumenta ili dizajna

Tijek `izrada-dokumenta` zove se „Izrada dokumenta ili dizajna”. Novi dokument ili dizajn (životopis, ponuda, izvještaj, letak, plakat, prezentacija, predložak): istraživanje → dizajn → izrada → QA u drugom pregledniku → isporuka. CLAUDE.md pravilo 25 (više struka = lanac).
Tijek je uključen (polje `enabled`). Globalni način rada svih tijekova određuje `config/workflow-gate.json` (vidi `prekidaci.md`).
Tijek je prenesen iz `izvorno napisan za katalog`.
Tijek se predlaže samo za posao težine najmanje 36; lakši posao ide jednom izvršitelju.
Polje `trazi_u` ima vrijednost naslov.
Polje `prioritet` ima vrijednost 85.
Kad zadatak ovog tijeka završi, dojava korisniku nosi odjeljak „🧭 Tijek posla”: koraci, tko je radio te koje su vještine i alati stvarno korišteni (izmjereno iz transkripta). Tijek se mijenja u workflows.json ili oznakom `workflow:<id>` na nalogu.

## Koraci
Korak 1: Manda (uloga research) — Skupi sadržaj i zahtjeve: izvorni podaci, predložak i brand (npr. Ništa ne izmišljaj; svaka tvrdnja ima izvor. Izlaz: sadržaj po odjeljcima + popis izvora. Vještina: Research. Treba: web i rag. Zamjena ako izvršitelj to ne može: Bez weba: samo priloženi materijal i RAG; ono što fali ide u „otvorena pitanja”, ne u tekst.
Korak 2: Grga (uloga design) — Raspored, tipografija, boje i brand; izlaz je predložak (HTML/CSS ili DOCX predložak) koji izrada samo puni. Bez teksta preko grafova i bez prozirnosti u PDF-u (lekcije pdf.js). Vještina: FrontendDesign. Treba: alate i pisanje. Zamjena ako izvršitelj to ne može: Bez FrontendDesign: postojeći brand predložak projekta i popis odstupanja.
Korak 3: Jelena (uloga izrada) — Složi konačnu datoteku po predlošku i izvezi SVE tražene formate (PDF/DOCX/PPTX; za DOCX vještina Docx, za PPTX Pptx). Alati iz kataloga: md2pdf.py, webapp_screenshot.py. Izlaz: putanje datoteka + naredba izvoza. Vještina: Pdf. Treba: alate i pisanje. Zamjena ako izvršitelj to ne može: Bez vještine formata: md2pdf.py iz Markdowna, uz napomenu u rezultatu.
Korak 4: Potjeh (uloga qa) — QA u DRUGOM pregledniku od onoga u kojem je dokument izrađen (izrada je Chromium → provjera u Firefoxu/Gecku i pdf.js; DOCX u LibreOfficeu): sadržaj prema zahtjevu, pravopis (RAG `hrvatski_pravopis`), preklapanje teksta, prijelom stranica, ispravnost poveznica. Izlaz: tablica nalaza sa snimkama. Vještina: WebappTesting. Treba: alate. Zamjena ako izvršitelj to ne može: Bez preglednika: pdftotext/pdffonts/pdfinfo i provjera pravopisa nad tekstom; reci da vizualna provjera nije rađena.
<!--u:nextcloud-->Korak 5: REGOČ (uloga isporuka) — Sustav (ReportBackTask, bez modela) šalje datoteku i TIJEK POSLA u isti chat; na Nextcloud samo kad je traženo (zadani lokalni).<!--/u--> Ovaj korak ne radi model: obavlja ga mehanizam `report-back` bez spawna agenta.
Lanac agenata je Manda → Grga → Jelena → Potjeh → REGOČ.

## Okidači
Okidači su regularni izrazi koje vrata tijeka (WorkflowGate) traže u naslovu i opisu zadatka; prvi tijek čiji uzorak pogodi dobiva zadatak, osim ako je zadatak lakši od praga. Koliko se puta tijek stvarno bira mjeri `tools/mjerila/workflow-odluke-mjera.ts`.
- `(napravi|izradi|pripremi|složi|sastavi|generiraj)\S* .{0,40}(dokument|životopis|cv\b|ponud|izvještaj|letak|plakat|prezentacij|brošur|predložak|docx|pdf|pptx)`
- `(dizajniraj|oblikuj|osmisli)\S* .{0,30}(dokument|stranic|letak|plakat|vizual|logotip|predložak|prezentacij)`
- `^(životopis|cv\b|ponuda|letak|plakat|prezentacija|brošura)`
- `(dokument|izvještaj|ponud|letak|plakat|brošur)\S* .{0,60}\b(pdf|docx|pptx|predložak|predlošk)`

## Isključenja
Uzorak iz ovog popisa poništava pogodak okidača ovog tijeka (traži se u istom tekstu kao okidači).
- `(\bQA\b|provjer|ne radi|\bpada\b|puca|kvar)`
- `(implementiraj|\bimplement|daemon|\bapi\b|servis|skript|modul|klijent|poslužitelj|server|aplikacij|\.ts\b|\bkod\b)`
 (Jelena): softverski predmet isključuje izradu dokumenta (isti obrazac kao Q1 kod dorada-isporuke) — inače „Implementiraj izvoz izvještaja u PDF” (sonda W0) postaje dokumentni tijek s QA-om u pregledniku. Kontrola: tests/workflow-gate-e2e.test.ts i docs/prijedlozi/tijekovi-5158-replay.ts.
