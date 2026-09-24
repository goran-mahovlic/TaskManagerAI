# Vrata i kočnice

[English](VRATA_I_KOCNICE.en.md) · [Natrag na pregled](README.md)

Sustav koji sam sebi dodjeljuje posao mora imati mjesta na kojima staje. Ima ih nekoliko i
namjerno se preklapaju. Ovaj dokument opisuje svako, zašto postoji i — važnije od svega —
**pravilo po kojem se nova vrata uopće smiju uključiti**.

---

## Pravilo za svaka nova vrata: sjena → mjerenje → uživo

Nijedan vratar ne ide ravno u pogon. Redoslijed je uvijek isti:

1. **`off`** — kod postoji, ne radi ništa.
2. **`shadow`** — sud se donosi i zapisuje („BIH blokirao"), ništa se ne zaustavlja.
3. **mjerenje** — iz zapisa sjene prebroji se koliko bi vrata odbila, i **koliko od toga
   pogrešno**.
4. **`on` / `live`** — tek kad je broj lažnih odbijanja poznat i prihvatljiv.

Povratak je uvijek jedna riječ u postavci, bez ponovnog pokretanja
(`config/features.example.json`: prekidači se čitaju uz TTL od 30 s; nepoznat ključ znači
isključeno).

Zašto tako strogo: vratar koji pogrešno blokira normalan rad biva isključen, a isključen vratar
ne štiti nikoga. U izvornom sustavu vratar s preširokom definicijom bio bi jednom riječi označio
14 % stvarno obavljenog posla kao blokiran (v. [PRAVILA_ISPORUKE.md](PRAVILA_ISPORUKE.md)).
Sjena je to pokazala prije nego se dogodilo.

---

## Ručna kočnica — globalna pauza

Gumb na ploči, ili `POST /api/pause`. Dvije razine:

- **globalna** — zaustavlja automatsko izvršavanje u cjelini i prekida tekuće spawnove;
- **po zadatku** — `POST /api/tasks/:id/pause`; zadatak zadržava svoje stanje, orkestrator ga
  samo preskače.

Stanje globalne pauze živi u datoteci (`REGOC_PAUSE_STATE`), jer ga čita više procesa i mora
preživjeti restart svakoga od njih.

Dvije odluke u dizajnu:

- **Pauza nije novo stanje zadatka.** Zadatak u radu mora se moći vratiti u rad; kroz automat
  stanja taj bi povratak bio zabranjen ili bi tražio nova pravila.
- **Nečitljiva datoteka znači „nije pauzirano".** Kočnica koja se sama zaglavi zbog pokvarenog
  JSON-a gora je od kočnice koja se ne aktivira. Prije kočnice jedini način zaustavljanja bio je
  ubiti proces — a to ostavlja zadatke u konačnom stanju i ubija i ispravne spawnove.

**U paketu:** `src/core/PauseControl.ts`.

---

## Vrata autonomije koja čitaju potrošnju

Orkestrator prije **svakog** spawna mjeri koliko je kvote potrošeno i prema tome se sam
spušta: iznad prvog praga prestaje sam vući posao iz reda, iznad drugog radi najviše jedan
agent, iznad trećeg ne izvršava ništa do obnove kvote. **Nalog čovjeka prolazi kroz sve
stupnjeve** — kočnica gasi samostalnost, ne odzivnost.

Najteže pitanje nije prag nego: **što ako mjerenja nema?** Tri stanja, tri odgovora:

| Stanje mjerila | Odluka | Zašto |
|---|---|---|
| postoji, ali **još nije dalo rezultat** | fail-open | svjež sustav se ne smije zaključati prije prvog mjerenja |
| radilo je, pa **zastarjelo** | fail-closed | ispad mjerila tretira se kao najgori slučaj |
| **nije instalirano** | fail-closed | to nije mladost sustava nego trajno sljepilo |

Treći redak dodan je nakon kvara: na jednom čvoru alat za mjerenje nije bio instaliran, dnevnik
mjerenja zato nikad nije nastao, a vrata su to čitala kao „svjež sustav" i puštala **punu
autonomiju bez gornje granice** — tjednima, sve dok red nije bio prazan pa kvar nitko nije vidio.

Uz obnovu kvote ide okidač (`src/core/QuotaWakeup.ts`) koji u trenutku obnove prisili svježe
mjerenje, pa se vrata otvore odmah umjesto da čekaju redovnu provjeru. Ne budi se ako u redu
nema posla, i odgađa se ako čovjek upravo radi.

**U paketu:** mjerilo `tools/session_usage.py`, prikaz na ploči `src/SessionUsage.ts`, red
čekanja autonomije `src/core/AutonomyQueue.ts`. Stupnjevana vrata u izvornom sustavu žive u
demonu domaćina.

---

## Strop usporednih agenata

Koliko agenata smije raditi istodobno **postavka je ploče**, ne varijabla okoline: mijenja se
uživo (Config → Usporedni agenti, `PUT /api/config/concurrency`), zadano 3, uvijek u rasponu
1–10. Orkestrator je čita najkasnije za pet sekundi. Smanjenje nikoga ne prekida — samo se novi
ne puštaju dok ih ne bude manje. Stupnjevi autonomije imaju prednost nad stropom.

`REGOC_MAX_AGENT_CONCURRENT` služi samo kao jednokratna početna vrijednost dok postavka ne
postoji. Pouka iz pogona: dok je strop dolazio iz okoline, zaboravljen `=1` iz davne
konfiguracije tjerao je sustav u serijski rad, a to se na ploči nije vidjelo.

**U paketu:** `src/core/ConcurrencySetting.ts` (promjene idu u `settings_history`).

---

## Strop stvaranja zadataka po autoru

Jednog dana u izvornom sustavu nastalo je **686 zadataka u dva sata** iz jednog izvora — jeka
izvještaja koji su postajali novi zadatci (v. [LEKCIJE.md](LEKCIJE.md)). Osigurač na
pokretanju agenata vidio je rafal tek kad je svaki zadatak već bio u bazi.

Zato vrata stoje na **stvaranju**, u jedinom ulazu ploče:

| Parametar | Vrijednost | Obrazloženje |
|---|---|---|
| prozor | 60 min, pomičan | provjerljivo nad `tasks.created_at` |
| po autoru | 30 / h | normalan promet: medijan 2 / h, p99 24 / h |
| globalno | 90 / h | najgori sat u povijesti: 41 / h |
| preko praga | **red čekanja**, ne odbijanje | ništa se ne gubi; `429` + `Retry-After` |
| dojava | jedna po epizodi | 686 poruka je isti kvar kao 686 zadataka |

Ponovljeno nad stvarnom poviješću: incident bi bio zaustavljen u 84 % zadataka, a normalan
promet odgođen u 1,6 %. Na vlastiti kvar (pad baze) vrata **propuštaju** uz zapis — osigurač
koji ruši dotok posla biva isključen.

**U paketu:** `src/core/TaskCreateBreaker.ts`, prekidači `taskCreateBreaker` /
`taskCreateBreakerLive`.

---

## Prekidač poruka

Svaki izvor poruka ima položaj `off` / `shadow` / `on` (`config/ingest-gate.example.json`,
`perSource`). Zadano je `"*": "off"` — nijedna poruka ne otvara zadatak dok ga vlasnik ne
uključi. U sjeni se vidi koliko bi zadataka nastalo, prije nego ijedan nastane. Pragovi težine
(`pragA`/`pragB`/`pragC`) određuju kada se poruka samo odgovori, a kada postaje zadatak.

Razlog iz pogona: dok razgovorni kanal nije vodio u zadatke, 78 % potrošnje mjesecima je bilo
nevidljivo na ploči. Ali kanal koji **svaku** poruku pretvara u zadatak jednako je loš — zato
prekidač i prag.

---

## Zamka: mjerilo koje se hrani radom koji vrata zabranjuju

U izvornom sustavu mjerilo potrošnje osvježavalo se **usput, radom agenata**. Kad su vrata
zaustavila agente, stalo je i osvježavanje. Mjerilo je zastarjelo, vrata su zastarjelu brojku
čitala kao „sve u redu" i pustila rad punom parom — točno u trenutku kad je najmanje smjelo.
Rad je zatim osvježio mjerilo, vrata su se zatvorila, i krug je krenuo ispočetka: **oscilator**.

Pravilo koje iz toga slijedi:

> **Mjerilo mora biti neovisno o onome što mjeri.** Osvježava ga zaseban proces u vlastitom
> ritmu, a zastarjela vrijednost znači „ne znam" — nikad „nula".

Isto vrijedi za svaka vrata: prije uključivanja pitaj **što hrani brojku koju vrata čitaju** i
staje li to hranjenje kad se vrata zatvore.

Vidi i: [ZIVOTNI_CIKLUS_ZADATKA.md](ZIVOTNI_CIKLUS_ZADATKA.md) · [SLOZI_SVOJ.md](SLOZI_SVOJ.md)
