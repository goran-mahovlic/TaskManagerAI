# Arhitektura — put jedne poruke kroz sustav

[English](ARHITEKTURA.en.md) · [Natrag na pregled](README.md)

Ovaj dokument prati jednu poruku od trenutka kad stigne do trenutka kad se odgovor vrati u isti
razgovor. Svaki korak ima svoje mjesto u paketu; uz svaki je navedeno gdje je i zašto postoji.

---

## Tok u jednoj slici

```
  KANAL                Telegram · ploča · POST /api/ingest · naredbeni redak
    │
    ▼
  RED PORUKA           SQLite (messages.db) — poruka je zapisana prije nego je itko čita
    │                  spajanje dijelova iste poruke istog pošiljatelja
    ▼
  RAZVRSTAVANJE        način rada (MINIMAL / STANDARD / COMPLEX) + razred težine E1–E5
    │                  → ocjena 1–100 → pragovi A / B / C → odgovori / zadatak / lanac / pitaj
    ▼
  ZADATAK NA PLOČI     jedini ulaz za stvaranje: vratari sadržaja, strop stvaranja
    │                  prioritet 1 → okidač u bazi stavlja zadatak u red izvršavanja
    ▼
  AUTOMATSKO           orkestrator uzima zadatak ako vrata puštaju: pauza, kvota, strop
  IZVRŠAVANJE          usporednih agenata, oznake „čeka čovjeka"
    │
    ▼
  SPAWN                CLI modela kao zaseban proces + blok identiteta iz registra
    │                  zadatak prelazi u in_progress prije pokretanja
    ▼
  REZULTAT             zadnji redak REGOC-STATUS + blok REGOC-IZLAZ (dokazi)
    │
    ▼
  KRITIČAR             drugi proces, bez modela: sam pokreće provjere nad diskom
    │
    ▼
  ZATVARANJE           completed ili blocked — tek nakon suda
    │
    ▼
  DOJAVA               jedna poruka po nizu zadataka, natrag u isti razgovor
```

---

## Sloj po sloj

### 1. Kanal

Poruka može doći iz razgovora (Telegram), s ploče, iz skripte ili iz bilo kojeg drugog sustava
koji zna poslati HTTP zahtjev. Generički ulaz je `POST /api/ingest` s pet polja koja ne znaju
za kanal: `source`, `externalId`, `replyTo`, `text`, `senderName`. Telegram je time samo jedan
od pozivatelja, a ne poseban slučaj u kodu.

Za svaki izvor postoji položaj `off` / `shadow` / `on` (`config/ingest-gate.example.json`).
Zadano je sve `off`: nijedna poruka ne otvara zadatak dok to vlasnik izričito ne uključi.

**U paketu:** `src/core/Ingest.ts`, `src/core/IngestConfig.ts`, `src/TelegramPoller.ts`
(pokretač `scripts/telegram-poller.ts`), postavka `TM_INGEST_GATE_CONFIG`.

### 2. Red poruka

Poruka se najprije **zapisuje** u SQLite red, a tek onda obrađuje. Padne li proces između
dolaska i obrade, poruka nije izgubljena. Red usput spaja dijelove: kanali dugačak tekst režu
na komade, a bez spajanja agent na jedno pitanje odgovori sedam puta.

**U paketu:** `src/core/MessageQueue.ts`.

### 3. Razvrstavanje i usmjeravanje

Dvije odluke, obje **bez modela**:

- **način rada i težina** — `ModeClassifier` daje razred E1–E5, `WeightScore` iz njega izvodi
  broj 1–100. Broj se nikad ne prelije u susjedni razred, pa prikaz ne mijenja odluku;
- **kome pripada** — ključne riječi iz registra agenata; pobjeđuje najdulja pogođena, `*` je
  rezervni put.

Pragovi `pragA`/`pragB`/`pragC` (zadano 16 / 36 / 81) određuju ishod: ispod A se samo
odgovori, iznad A otvara se zadatak, iznad B puni lanac uloga, iznad C traži se ljudska
potvrda plana.

Zašto bez modela: sve što stoji na putu **svake** poruke mora biti determinističko i besplatno.
Kad je u sustavu iz kojega je paket izvučen model bio vratar, krivo je usmjerio 92 % prometa.

### 4. Zadatak na ploči

Zadatak nastaje na **jednom jedinom mjestu** — u rukovatelju stvaranja zadatka na ploči. Kroz
njega prolaze web obrazac, agentov `curl`, orkestrator i ulaz poruka. Drugi stvaratelj značio
bi granu koja zaobilazi vratare. Na tom mjestu stoje:

- straža jeke (`DispatchGuard`) — izvještaj agenta ne smije postati novi zadatak;
- strop stvaranja po autoru (`TaskCreateBreaker`), v. [VRATA_I_KOCNICE.md](VRATA_I_KOCNICE.md).

Prioritet 1 nije samo redoslijed: okidač u bazi zadatak odmah stavlja u tablicu
`execution_queue`.

### 5. Automatsko izvršavanje

Orkestrator je petlja koja u svakom prolazu pita: smije li se išta pokrenuti? Odgovor ovisi o
globalnoj pauzi, stropu usporednih agenata (postavka na ploči, zadano 3), stanju kvote i
oznakama na zadatku. Svaki razlog zbog kojeg prolaz nije ništa napravio zapisuje se — tiho
stajanje je kvar.

**U paketu:** `src/core/orchestrator/` (`Orchestrator.ts`, `SpawnQueue.ts`, `Watchdogs.ts`,
`Liveness.ts`), pokretač `bun scripts/orchestrator.ts`, postavke
`config/orchestrator.example.json` (`TM_ORCHESTRATOR_CONFIG`). Zadano je `enabled: false`:
svježa instalacija ne diže agente samo zato što je netko pokrenuo skriptu.

### 6. Spawn s identitetom

Agent nije stalni proces nego **CLI modela pokrenut za jedan zadatak**. Naredba i argumenti
idu operacijskom sustavu kao popis, nikad kroz ljusku — opis zadatka je korisnički tekst i
navodnik u njemu ne smije postati izvršni znak. Prompt se slaže iz predloška
(`templates/prompt/zadatak.md`, `TM_PROMPT_TEMPLATES`), a identitet iz registra — v.
[IDENTITET.md](IDENTITET.md).

Koji se CLI poziva stvar je konfiguracije (`executors` u `orchestrator.json`): `claude`,
drugi CLI ili bilo koji poslužitelj s OpenAI-kompatibilnim sučeljem preko HTTP-a.

**U paketu:** `Executors.ts`, `PromptBuilder.ts`, `AgentRegistry.ts`.

### 7. Rezultat, kritičar, zatvaranje

Agent ishod javlja zadnjim retkom `REGOC-STATUS:` i strukturiranim blokom `REGOC-IZLAZ` s
dokazima (v. [PRAVILA_ISPORUKE.md](PRAVILA_ISPORUKE.md)). Zatim nezavisni kritičar, drugi
proces bez modela, sam pokreće provjere nad onim što je na disku. Tek tada se zadatak zatvara.

U izvornom sustavu zadatak zatvara **samo orkestrator, nakon suda kritičara** (v.
[ZIVOTNI_CIKLUS_ZADATKA.md](ZIVOTNI_CIKLUS_ZADATKA.md)). U paketu jezgra još ne zatvara umjesto
agenta: agentov `PUT status` prolazi kroz vratare ploče (`CompletionGuard`, `CriticGate`,
`StepSchema`, `ResearchRagGate`, `GitCommitGate`, `WorkflowGate`, svi u `src/core/`).

### 8. Dojava

Niz zadataka koji je nastao iz jedne poruke daje **jednu** poruku natrag, u isti razgovor iz
kojega je poruka stigla (`replyTo`). Tri poruke o jednom poslu su šum; jedna poruka o tri
zadatka je vijest.

**U paketu:** `src/core/ReportBackTask.ts`; adresa ploče u poruci dolazi iz `TM_BOARD_URL`,
bez zadane vrijednosti.

---

## Tri pravila koja drže cijeli tok

1. **Svaki sloj koji nešto radi, zapisuje to u bazu.** Sloj iznad ne vjeruje pamćenju sloja
   ispod. Padne li bilo koji proces, stanje je na ploči.
2. **Na vrućem putu nema modela.** Model se troši na posao, ne na odluku kome posao pripada.
3. **Proizvođač ne ocjenjuje sam sebe.** Izvršitelj javlja ishod, sud donosi netko drugi.

Vidi i: [TIM.md](TIM.md) · [BAZE.md](BAZE.md) · [VRATA_I_KOCNICE.md](VRATA_I_KOCNICE.md)
