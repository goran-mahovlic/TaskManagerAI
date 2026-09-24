# Tim — uloge, ne osobe

[English](TIM.en.md) · [Natrag na pregled](README.md)

U izvornom sustavu svaka uloga ima ime iz hrvatske predaje. Imena su korisna za razgovor, ali
nisu bit: bit je **podjela posla na uloge**, svaka sa svojim ovlastima, vještinama i modelom.
Ovaj dokument opisuje uloge tako da ih možeš popuniti vlastitim agentima.

---

## Načelo izbora modela

Nijedan model nije najbolji za sve, a razlika u cijeni zna biti deseterostruka. Zato:

- **prosudba** (arhitektura, sigurnost, analiza) → najjači model;
- **brzina i razgovor** → srednji model;
- **razvrstavanje, sažimanje, ugradnje** → lokalni model — jeftino i privatno.

Model je **polje u registru**, nikad konstanta u kodu. Kad izađe nov model, mijenja se jedan
redak. Smjer spuštanja je samo nadolje: promašen jeftin pokušaj košta jedan ponovni krug,
promašen skup pokušaj košta bez gornje granice.

---

## Uloge

| Uloga | Što smije | Vještine (primjer) | Model i zašto |
|---|---|---|---|
| **Orkestrator** | dijeli posao, sastavlja rezultat, zatvara zadatke nakon suda kritičara; **ne izvršava sam** | CORE, System, Agents | najjači — odluka o tome tko radi što je najskuplja pogreška |
| **Arhitekt** | postavlja pitanja dok zamisao ne izdrži; vodi pojmovnik i odluke (ADR) | Development, GrillWithDocs | najjači — plan koji ne izdrži plaća se u svakom sljedećem koraku |
| **Inženjer** | piše i mijenja kod, test prvo | Development, TDD, DiagnosingBugs, CreateCLI | najjači za zahvat, srednji za sitnicu |
| **Sigurnost** | traži čime se ovo može zloupotrijebiti; napadački pogled | Recon, RedTeam, OSINT | najjači — promašaj je ovdje najskuplji |
| **Istraživač** | čita izvore, donosi činjenice s poveznicama, upisuje nalaz u RAG | Research, OSINT | najjači ili srednji, ovisno o dubini |
| **Analitičar** | isti problem iz više kutova, traži što svi previđaju | Council, FirstPrinciples | najjači |
| **Dizajner** | sučelja i vizualni jezik; provjera u pravom pregledniku | FrontendDesign, Browser | najjači |
| **Umjetnik** | slike, dijagrami, ilustracije | Art, Excalidraw, AlgorithmicArt | srednji — izlaz se ocjenjuje okom, ne dokazom |
| **QA** | sumnja u tuđi rad, uključujući orkestratorov | CORE | srednji — provjera je ponavljanje naredbi, ne prosudba |
| **Sučelje prema korisniku (24/7)** | razgovor s čovjekom kroz kanal, danonoćno; prima naloge i vraća dojave | CORE | srednji — brz i jeftin, jer radi stalno |
| **Glas** | govor u tekst i tekst u govor | — | lokalni servisi; ono što se ne mora poslati van, ne šalje se |

Uobičajen lanac za veći posao: **arhitekt → inženjer → QA → sigurnost**. Zamisao se prvo
izoštri, pa napiše, pa provjeri, pa napadne. Svaki korak je zaseban zadatak, pa se poslije vidi
gdje je zapelo — a zapinje uvijek na koraku koji je netko preskočio.

Istraživač i analitičar ulaze kad treba istražiti ili odvagnuti odluku; dizajner i umjetnik
kad posao ima vizualni izlaz.

### Zašto orkestrator ne izvršava

Orkestratoru je uvijek brže napraviti sam nego objasniti. Kad to počne raditi, sustav se
pretvara u jedan dugi razgovor bez traga, i vraćamo se na problem koji je sustav trebao
riješiti. U izvornom sustavu orkestrator je zato izuzet iz automatskog pokretanja: zadatak
dodijeljen orkestratoru znači „radi ga glavna sesija", a ne „pokreni agenta tog imena".

### Vještine se imenuju u koraku

Mjereno u izvornom sustavu: od 11 poziva vještina u 124 sjednice **svi** su bili izričito
naručeni. Agent vještinu gotovo nikad ne izabere sam. Zato korak posla imenuje vještinu
(„koristi DiagnosingBugs"), a ne samo nudi popis.

---

## Kako dodati vlastitog agenta

Registar je **jedan JSON** i jedini izvor istine o tome tko postoji. Kreni od primjera:

```bash
cp config/agents.example.json config/agents.json
```

Jedan zapis:

```json
{
  "id": "analiticar-podataka",
  "ime": "Analitičar podataka",
  "uloga": "Cjevovodi podataka i izvještaji. Kratko, s brojkama; svaka tvrdnja uz naredbu koja je daje.",
  "model": "",
  "keywords": ["izvještaj", "cjevovod", "csv"],
  "rag": ["agent_analiticar"],
  "executor": ""
}
```

| Polje | Značenje |
|---|---|
| `id` | ime nositelja zadatka: mala slova, znamenke, `-`, `_`; do 32 znaka |
| `uloga` | tekst koji ulazi u blok identiteta („Tko si") |
| `model` | ime modela koje razumije izvođač; prazno = zadano izvođača |
| `keywords` | po čemu poruka dolazi ovom agentu; najdulja pogođena pobjeđuje, `*` je rezervni put |
| `rag` | zbirke znanja koje agent čita i u koje piše |
| `executor` | izvođač iz `orchestrator.json`; prazno = zadani |

Putanja registra: `config/agents.json`, `$TM_HOME/config/agents.json` ili vlastita putanja u
`TM_AGENTS_CONFIG`. Registar se čita pri svakom prolazu, pa nov agent vrijedi bez restarta.

**Samo ploča, bez orkestratora?** Popis dopuštenih nositelja može se dati i kao
`TM_AGENTS=ana,marko`. Izvori se **zbrajaju**, ne pregaze: registar ∪ `TM_AGENTS` ∪ sustavski
nositelji (`user`, `scheduler`). Bez ijednog izvora provjerava se samo oblik imena
(v. `src/core/AgentIds.ts`).

Gotov primjer tima s devet uloga i njihovim vještinama je u `agents/regoc-tim.json`, a
`bash scripts/install-agents.sh` ga upisuje i ispisuje koje vještine nedostaju
(`docs/AGENTI.md`).

### Tri stvari koje vrijedi znati prije prvog agenta

1. **Nositelj je nalog, ne oznaka.** Čim zadatak dobije nositelja i stanje `pending`, a
   orkestrator je uključen, agent će biti pokrenut. Pazi koga upisuješ.
2. **Identitet se šalje pri svakom pokretanju.** Agent koji ne dobije ulogu i stil u prvoj
   poruci ponaša se kao generički pomoćnik, bez obzira na to što piše u registru.
3. **Dvije do tri uloge su dovoljne za početak.** Koordinator ima smisla tek kad je izvršitelja
   više — v. [SLOZI_SVOJ.md](SLOZI_SVOJ.md).

Vidi i: [IDENTITET.md](IDENTITET.md) · [ARHITEKTURA.md](ARHITEKTURA.md)
