# Tijek osint-lookup — OSINT / izviđanje (po vrsti cilja)

Tijek `osint-lookup` zove se „OSINT / izviđanje (po vrsti cilja)”. Prikupljanje obavijesti iz javnih izvora nad jednim ciljem. Vrsta cilja bira dubinu i izvore; zadano je pasivno — ničim se ne dira sam cilj.
Tijek je uključen (polje `enabled`). Globalni način rada svih tijekova određuje `config/workflow-gate.json` (vidi `prekidaci.md`).
Tijek je prenesen iz `~/.claude/skills/Workflows/{PassiveRecon,DomainRecon,IpRecon,NetblockRecon,PeopleLookup,EntityLookup,CompanyLookup,CompanyDueDiligence,BountyPrograms}.md`.
Tijek se predlaže samo za posao težine najmanje 36; lakši posao ide jednom izvršitelju.
Polje `trazi_u` ima vrijednost naslov.
Polje `prioritet` ima vrijednost 60.
Kad zadatak ovog tijeka završi, dojava korisniku nosi odjeljak „🧭 Tijek posla”: koraci, tko je radio te koje su vještine i alati stvarno korišteni (izmjereno iz transkripta). Tijek se mijenja u workflows.json ili oznakom `workflow:<id>` na nalogu.

## Koraci
Korak 1: Malik (uloga ovlastenje) — Vrata prije svega: tko je naručio, koji je opseg (cilj i vrste podataka), koja pravna osnova (GDPR/FCRA/zabrana uhođenja) i je li način `aktivno` pisano odobren. Ako ijedna stavka nedostaje — STOP, tijek ne kreće. Vještina: OSINT. Zamjena ako izvršitelj to ne može: Bez alata: prepiši naručitelja, opseg i pravnu osnovu u tri retka; bez njih se ne nastavlja.
Korak 2: Manda (uloga prikupljanje) — Prikupljanje po `vrsta_cilja` iz izvornog spisa (domena: WHOIS, DNS, certificate transparency, poddomene, pošta; ip: IPInfo, obrnuti DNS, ASN, netblok; netblock: vlasništvo i dodjela; osoba/tvrtka: registri, profesionalne mreže, sudski i poslovni registri; bounty: BountyPrograms.ts). Za `dubinska-analiza` otkrivanje domena je PRVO i blokira ostale faze. Svaki nalaz nosi izvor i vrijeme. Vještina: OSINT. Treba: web i alate. Zamjena ako izvršitelj to ne može: Bez weba: samo RAG i postojeći spisi; svaku rupu navedi izrijekom umjesto da je prešutiš.
Korak 3: Dora (uloga korelacija) — Spoji nalaze iz više izvora, odvoji dokazano od pretpostavljenog; tvrdnja bez najmanje tri neovisna izvora ide u „nepotvrđeno“. Označi proturječja. Vještina: FirstPrinciples. Treba: dug-kontekst. Zamjena ako izvršitelj to ne može: Bez razrade: nabroji nalaze s izvorom i uz svaki napiši je li potvrđen ili nije.
Korak 4: Kosjenka (uloga izvjestaj) — Izvještaj: sažetak, karta cilja, crvene zastavice s procjenom rizika, preporuka i granice pokrivenosti. Izlaz obavezno u RAG (--type istrazivanje uz --source). Treba: rag i pisanje. Zamjena ako izvršitelj to ne može: Bez RAG-a: spremi izvještaj u docs/ i navedi da upis u RAG nedostaje.
Lanac agenata je Malik → Manda → Dora → Kosjenka.

## Okidači
Okidači su regularni izrazi koje vrata tijeka (WorkflowGate) traže u naslovu i opisu zadatka; prvi tijek čiji uzorak pogodi dobiva zadatak, osim ako je zadatak lakši od praga. Koliko se puta tijek stvarno bira mjeri `tools/mjerila/workflow-odluke-mjera.ts`.
- `osint`
- `due diligence|dubinsk[au] (provjer|analiz)`
- `background check|provjera pozadine`
- `izviđanje|reconnaissance|\brecon\b`
- `bug ?bounty|bount(y|i) program`
- `napadn[au] površin|attack surface`
- `(provjeri|istraži|raspitaj se o) (tvrtk|osob|domen|poslovnom partneru|dobavljač)`
- `(mapiraj|popiši) (infrastrukturu|poddomene|subdomen)`
- `whois|certificate transparency`
