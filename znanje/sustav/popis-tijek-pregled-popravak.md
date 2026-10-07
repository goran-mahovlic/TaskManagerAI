# Tijek pregled-popravak — Pregled → plan popravka → popravak

Tijek `pregled-popravak` zove se „Pregled → plan popravka → popravak”. Puna provjera kvalitete gotove značajke ili aplikacije: pregled kao krajnji korisnik → razvrstan popis kvarova → popravci → regresija na ploči.
Tijek je uključen (polje `enabled`). Globalni način rada svih tijekova određuje `config/workflow-gate.json` (vidi `prekidaci.md`).
Tijek je prenesen iz `~/.claude/skills/Workflows/ReviewPlanRepairTask.md (+ spojen ~/.claude/skills/Workflows/ComprehensiveUISimTesting.md)`.
Tijek se predlaže samo za posao težine najmanje 36; lakši posao ide jednom izvršitelju.
Polje `trazi_u` ima vrijednost naslov.
Polje `prioritet` ima vrijednost 60.
Kad zadatak ovog tijeka završi, dojava korisniku nosi odjeljak „🧭 Tijek posla”: koraci, tko je radio te koje su vještine i alati stvarno korišteni (izmjereno iz transkripta). Tijek se mijenja u workflows.json ili oznakom `workflow:<id>` na nalogu.

## Koraci
Korak 1: Malik (uloga review) — Pregled kao krajnji korisnik: svaka stranica, tipka, poveznica, obrazac, statički resurs i krajnja točka; usporedba s prihvatnim kriterijem. Izlaz: tablica (stranica | stanje | što radi | što nedostaje | težina) i popis P1/P2/P3. Kod računskih ili simulacijskih sučelja provjeri i da su vrijednosti fizikalne, ne samo da se ekran iscrtava. Vještina: WebappTesting. Treba: alate i web. Zamjena ako izvršitelj to ne može: Bez preglednika: prođi krajnje točke curlom i popiši odgovore; izostavljeno navedi izrijekom (nema tihih rezova).
Korak 2: Kosjenka (uloga plan) — Razvrstaj nalaze (kvar / nedostaje značajka / regresija), procijeni težinu, dodijeli izvršitelja, odredi ovisnosti; za svaki P1/P2 zapiši ISA. Treba: dug-kontekst. Zamjena ako izvršitelj to ne može: Bez razrade: poredaj nalaze po težini i uz svaki napiši jednu rečenicu što je popravak.
Korak 3: Jelena (uloga repair) — Popravci redom po prioritetu; svaki nosi provjeru (vrata u pet koraka) i pokrenute testove pogođenog dijela. Zapiši što je izmijenjeno i zašto. Vještina: DiagnosingBugs. Treba: alate i pisanje. Zamjena ako izvršitelj to ne može: Bez DiagnosingBugs: opiši kako se kvar ponavlja, što si promijenio i koja naredba to dokazuje.
Korak 4: Potjeh (uloga regresija) — Zatvori zadatke na ploči s dokazom i pokreni završnu regresiju preko svih pregledanih stranica/krajnjih točaka; radni se tijek ne proglašava gotovim dok regresija ne prođe. Treba: alate. Zamjena ako izvršitelj to ne može: Bez alata: nabroji koje provjere treba ponoviti i po čemu se vidi da su prošle.
Lanac agenata je Malik → Kosjenka → Jelena → Potjeh.

## Okidači
Okidači su regularni izrazi koje vrata tijeka (WorkflowGate) traže u naslovu i opisu zadatka; prvi tijek čiji uzorak pogodi dobiva zadatak, osim ako je zadatak lakši od praga. Koliko se puta tijek stvarno bira mjeri `tools/mjerila/workflow-odluke-mjera.ts`.
- `pregledaj (i popravi|sve|cijel|aplikaciju|sučelje)`
- `prođi kroz (aplikaciju|sučelje|sve stranice)`
- `provjeri sve (stranice|ekrane|krajnje točke|endpoint)`
- `popravi sve (greške|kvarove|nedostatke)`
- `prije (proglašenja|nego proglasimo) (gotovim|spremnim|produkcijskim)`
- `(audit|revizija) kvalitete`
