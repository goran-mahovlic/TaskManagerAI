# Tijek research — Istraživanje

Tijek `research` zove se „Istraživanje”. Prikupljanje izvora → analiza → sinteza sa zaključkom i preporukom.
Tijek je uključen (polje `enabled`). Globalni način rada svih tijekova određuje `config/workflow-gate.json` (vidi `prekidaci.md`).
Tijek je prenesen iz `REGOČ TeamWorkflow.ts (research)`.
Tijek se predlaže samo za posao težine najmanje 36; lakši posao ide jednom izvršitelju.
Polje `trazi_u` ima vrijednost naslov.
Polje `prioritet` ima vrijednost 30.
Kad zadatak ovog tijeka završi, dojava korisniku nosi odjeljak „🧭 Tijek posla”: koraci, tko je radio te koje su vještine i alati stvarno korišteni (izmjereno iz transkripta). Tijek se mijenja u workflows.json ili oznakom `workflow:<id>` na nalogu.

## Koraci
Korak 1: Manda (uloga research) — Prikupi izvore (RAG, web, dokumentacija); svaki nalaz s poveznicom. Vještina: Research. Treba: web i rag. Zamjena ako izvršitelj to ne može: Bez weba: pretraži samo RAG i postojeće dokumente; izostanak izvora izrijekom navedi.
Korak 2: Dora (uloga analyze) — Razloži na temeljne činjenice, odvoji dokazano od pretpostavljenog. Vještina: FirstPrinciples. Treba: dug-kontekst. Zamjena ako izvršitelj to ne može: Bez FirstPrinciples: nabroji tri činjenice za i tri protiv, bez razrade.
Korak 3: Kosjenka (uloga synthesize) — Zaključak i preporuka s obrazloženjem; izlaz obavezno u RAG (tip=istrazivanje). Treba: dug-kontekst.
Lanac agenata je Manda → Dora → Kosjenka.

## Okidači
Okidači su regularni izrazi koje vrata tijeka (WorkflowGate) traže u naslovu i opisu zadatka; prvi tijek čiji uzorak pogodi dobiva zadatak, osim ako je zadatak lakši od praga. Koliko se puta tijek stvarno bira mjeri `tools/mjerila/workflow-odluke-mjera.ts`.
- `istraž`
- `prouči`
- `usporedi`
- `koje su opcije`
- `analiziraj tržište`
- `napravi pregled`
- `koji .* odabrati`

## Isključenja
Uzorak iz ovog popisa poništava pogodak okidača ovog tijeka (traži se u istom tekstu kao okidači).
- `usporedi .{0,20}(s|sa) (v\d|verzij|predlošk|izvornik)`
