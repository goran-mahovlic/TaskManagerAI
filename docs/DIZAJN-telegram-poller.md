# Dizajn — Telegram poller: ulazni kanal koji zove `POST /api/ingest`

| | |
|---|---|
| **Autorica** | Kosjenka (Architect), TASK-4799 (PRJ-048) |
| **Datum** | 10.09.2026. |
| **Polazište** | `docs/ROADMAP_SAMOSTALNOST.md` §3 |
| **Nadograđuje** | `src/TelegramConfig.ts` (izlazni kanal, TASK-026/4797 — **gotovo**) |
| **Koristi** | `POST /api/ingest` (U6/TASK-4266), `src/core/Ingest.ts`, `src/core/IngestConfig.ts` |

---

## 1. Što nedostaje i što se NE radi

Izlazni smjer je gotov: `TelegramConfig.ts` nosi bot token i chat id kao polja konfiguracije
(bez zadanih vrijednosti), ima karticu na Config stranici, `GET/PUT /api/telegram/config`,
`POST /api/telegram/proba` i automatsku obavijest o završenom/neuspjelom zadatku.

Nedostaje **ulazni** smjer: poruka → zadatak. On danas postoji samo u živoj instalaciji
(`~/.claude/tools/Telegram/`, vezano uz Klaudio agenta) i **nije** u paketu.

**Ključna odluka: poller ne dobiva nimalo pameti.** Paket već ima kanal-agnostičan ulaz
`POST /api/ingest` koji radi ocjenu težine, pragove A/B/C, izbor projekta, položaj po izvoru
(`off`/`shadow`/`on`) i sastavljanje opisa s koracima — sve deterministički, bez ijednog
poziva modelu. Poller je zato **prevoditelj protokola, ne vratar**:

```
Telegram getUpdates  →  poller  →  POST /api/ingest  →  handleCreateTask  →  zadatak
                          ▲                              (jedini ingress ploče)
                          └── ovdje NEMA klasifikacije, nema odluke, nema baze
```

Ako pollleru ikad zatreba `if` o tome je li poruka vrijedna zadatka, to je znak da odluka
pripada `IngestConfig`-u, ne pollleru.

---

## 2. Gdje živi i kako se pokreće

**Nova datoteka:** `src/TelegramPoller.ts` (uz `TelegramConfig.ts`, isti par kao
izlaz/ulaz), plus tanak pokretač `scripts/telegram-poller.ts` za samostalan proces.

Dva načina rada, oba iza iste sklopke `ulaz.ukljucen`:

| Način | Kada | Kako |
|---|---|---|
| **A — u procesu ploče** (zadano) | jedna instalacija, jedan proces | `TaskWebUI` pri startu poziva `pokreniTelegramPoller()`; petlja `setTimeout`, `unref()` da ne drži proces |
| **B — zaseban proces** | ploča iza reverse-proxyja bez izlaza na internet, ili više instanci | `bun scripts/telegram-poller.ts --api http://…:17781` |

Način B mora postojati jer je poller jedini dio paketa koji **sam ide na internet**; netko
će ga htjeti odvojiti. Oba načina zovu **isti** `POST /api/ingest`, dakle isti kod.

**Webhook se ne izvodi.** `getUpdates` (long polling) ne traži javni HTTPS, certifikat ni
otvoren port prema van — a upravo bi to bio prvi zid za korisnika koji paket vrti kod kuće.
Sučelje modula je ipak takvo (`obradiUpdate(u: Update)`) da se webhook kasnije doda kao
drugi pozivatelj iste funkcije, bez ijedne promjene u ostatku.

---

## 3. Konfiguracija — proširenje `config/telegram.json`

Ulazni smjer dobiva **potpolje** `ulaz`, a ne novu datoteku: isti bot token vrijedi za oba
smjera i dvije datoteke značile bi dvije istine o istom tokenu.

```jsonc
{
  "ukljucen": false, "botToken": "", "chatId": "",        // ← postojeće (izlaz)
  "obavijestZavrseno": true, "obavijestGreska": true, "prefix": "📋",

  "ulaz": {                                              // ← novo
    "ukljucen": false,                                   // ulaz se NE pali s izlazom
    "intervalSek": 3,                                    // razmak između getUpdates (1–60)
    "timeoutSek": 25,                                    // long-poll rok (0–50, Telegram max 50)
    "dopusteniChatovi": [],                              // [] = SVE što bot vidi; inače popis
    "dopusteniKorisnici": [],                            // [] = svi; inače user_id-evi
    "okidac": "",                                        // '' = svaka poruka; npr. "/zadatak"
    "sameSpomeni": false,                                // u grupi reagiraj samo na @bot
    "potvrdaUChat": true,                                // pošalji natrag broj zadatka
    "maxDuljina": 4000                                   // dulje se reže (Ingest.MAX_TEKST = 20000)
  }
}
```

**Zadane vrijednosti drže se pravila iz ADR-0001 §5.1:** `ulaz.ukljucen: false`, prazni
popisi, prazan okidač. Instalacija koja upiše samo bot token dobiva **izlaz**, a ulaz tek
kad ga izričito uključi — jer bot koji sam otvara zadatke iz svake poruke koju vidi je
iznenađenje, ne značajka.

**Stanje ulazne petlje** (`offset`, zadnja greška, broj obrađenih) **ne ide u konfiguraciju**
nego u `$TM_HOME/data/telegram-poller.json`. Konfiguracija je ono što je korisnik izabrao;
stanje je ono što je stroj zatekao, i miješanje toga dvoga znači da svaki `PUT` s ploče
može pregaziti `offset` i vratiti već obrađene poruke.

`validateTelegramPatch` se proširuje na ugniježđeni objekt: nepoznato polje **unutar**
`ulaz` mora se odbiti jednako kao na prvoj razini (danas `dopustena = Object.keys(ZADANE_POSTAVKE)`
pokriva samo prvu razinu — to je izmjena koju Jelena mora napraviti izričito).

---

## 4. Petlja

```ts
export async function jedanProlaz(cfg, stanje, api): Promise<Ishod>
```

Jedan prolaz, čista granica prema mreži i prema ploči — pa je testabilan bez ijednog od toga.

1. **Dohvat.** `GET https://api.telegram.org/bot{token}/getUpdates?offset={offset}&timeout={timeoutSek}&allowed_updates=["message"]`
2. **Za svaki `update`:**
   1. `offset = update_id + 1` **prije** obrade (v. §5 — najviše jednom);
   2. filtri: `dopusteniChatovi`, `dopusteniKorisnici`, `okidac`, `sameSpomeni`;
      odbačeno se **broji**, ne loguje po komadu (grupa s prometom inače zatrpa dnevnik);
   3. tekst: `message.text ?? message.caption ?? ''`; prazno → preskoči;
   4. `POST {api}/api/ingest` (§6);
   5. ako `potvrdaUChat` i odgovor nosi `taskId` → `posaljiTelegramPoruku()` **u isti chat**
      (`reply_to_message_id = message.message_id`).
3. **Zapiši stanje** (`offset`, `ts`, brojači) atomski (`tmp` + `rename`, kao `saveTelegramConfig`).

**Odgovor koji poller mora znati pročitati** (mjereno u `handleIngest`):

| Ishod | Značenje | Što poller radi |
|---|---|---|
| `201 { ok:true, created:true, taskId }` | otvoren zadatak | potvrda u chat s brojem |
| `200 { ok:true, created:false, action, reason }` | ulaz je odlučio da nije zadatak (`shadow`, ispod praga A, `off`) | **tišina** — inače bot komentira svaku poruku |
| `400 { ok:false, greske }` | neispravan zahtjev — **naš** kvar | dnevnik, bez poruke u chat |
| `422` / `429` | odbio vratar ploče (anti-echo, strop stvaranja) | dnevnik + **jedna** poruka u chat, prigušeno na 1/10 min |
| `5xx` / mreža | ploča ne radi | backoff (§5), bez poruke |

Poller **ne tumači** `action` ni `weight` — samo ih zapisuje. To je granica: čim ih počne
tumačiti, nastaje druga istina o pragovima.

---

## 5. Tri stvari koje moraju biti točne

Poller je kratak, ali ima tri mjesta na kojima se griješi, i sva tri su već poznata iz
`RegocDaemon.ts`:

**5.1 Najviše jednom (`offset` prije obrade).** Telegram vraća isti `update` dok ga se ne
potvrdi većim `offset`-om. Ako se `offset` pomiče **poslije** uspješnog `POST`-a, pad ploče
usred obrade znači da ista poruka pri sljedećem prolazu otvara **drugi** zadatak. Zato:
`offset` prvo, pa obrada. Cijena je da se poruka u rijetkom padu izgubi — a izgubljena
poruka je manja šteta od tihe duplikacije zadataka (isti izbor kao `claimMessage()` u živom
daemonu, `RegocDaemon.ts:1495`).

Druga brana, jer je prva „najviše jednom" samo unutar procesa: `externalId` se šalje kao
`` `${chat.id}:${message.message_id}` `` — jedinstven i stabilan po Telegramovoj definiciji,
pa `data/ingest.jsonl` uvijek pokazuje je li poruka već ušla.

**5.2 Jedna petlja, ne dvije.** Dva pollera s istim tokenom **međusobno kradu** `getUpdates`
(Telegram isporučuje svaki update samo jednom pozivatelju), pa se poruke tiho gube. Zaštita
je ista koja je u živom daemonu riješila akumulaciju duplih agenata
(`RegocDaemon.ts:307–320`, cross-process `pgrep` brana): **datoteka-brava** s PID-om u
`$TM_HOME/data/telegram-poller.lock`. Ako je vlasnik živ (`process.kill(pid, 0)`) → drugi
poller se ne pokreće i to jasno kaže. Ovo je uvjet, ne dodatak: način A i način B iz §2 se
inače pokrenu zajedno i kvar je nevidljiv.

**5.3 Backoff i `409 Conflict`.** Telegram vraća `429` s `retry_after`, i `409` kad je za
istog bota postavljen webhook. Oba se moraju razlikovati od mrežnog kvara:

* `429` → čekaj **točno** `parameters.retry_after` sekundi;
* `409` → **zaustavi petlju** i javi na ploču „za ovog bota postavljen je webhook; makni ga
  ili isključi poller" — ponavljanje ovdje ne pomaže nikad;
* `401` → token nije valjan → zaustavi, javi, **ne** ponavljaj (isti razlog kao `no-channel`
  u `sendTelegramText`, `RegocDaemon.ts:621`: trajno stanje se ne liječi ponavljanjem);
* mreža/`5xx` → eksponencijalni backoff s jitterom (3 s → 5 min), jer bi bez jittera dvije
  instalacije iza istog izlaza udarile u limit u istoj sekundi.

---

## 6. Preslikavanje Telegram → `/api/ingest`

```jsonc
{
  "source":     "telegram",
  "externalId": "-1001234567890:4821",        // chat.id:message_id  (§5.1)
  "replyTo":    "-1001234567890",             // chat.id — paket ga NE tumači, samo zapisuje
  "text":       "<message.text ili caption>",
  "senderName": "<from.first_name> (@<username>)",
  "receivedAt": "<ISO iz message.date>"
}
```

Namjerno se **ne** šalju `projectId`, `assignee` ni `tags`: o projektu odlučuje
`IngestConfig.projektZaIzvor()` po ključu izvora, a `kljuceviIzvora()` već traži redom
`telegram:<chatId>` → `<chatId>` → `telegram` → `*` (`IngestConfig.ts:100–109`). Slanje
`projectId` iz pollera bi tu odluku zaobišlo i napravilo drugu istinu o tome čemu poruka
pripada.

**`replyTo` je za paket neproziran niz** — `Ingest.ts` ga izričito ne tumači i ne šalje.
Poller ga zato mora sam pročitati natrag iz odgovora kad šalje potvrdu; to je jedina točka
u kojoj poller zna da je „telegram" nešto više od imena izvora.

**Čišćenje biljega ne radi poller.** `Ingest.ts` (redci 129–131) već skida `[OD: …]` i
`[PRETHODNI KONTEKST …]` prije ocjene. Druga preslika tog čišćenja u pollleru bila bi drugo
pravilo koje tiho odluta.

---

## 7. Ploča

Kartica Telegram (`renderTelegram`, `TaskWebUI.ts:7346`) dobiva drugi odjeljak **„Ulaz"**:

* prekidač `ulaz.ukljucen` + polja `intervalSek`, `okidac`, `dopusteniChatovi`;
* stanje petlje iz `data/telegram-poller.json`: **radi / stoji / greška**, `offset`, koliko
  je poruka obrađeno, zadnja greška i njezino vrijeme;
* gumb **„Probaj ulaz"** → `POST /api/telegram/ulaz/proba`: napravi **jedan** `getUpdates`
  s `timeout=0` i vrati *koliko poruka čeka i iz kojih chatova* — **bez** otvaranja ijednog
  zadatka. Bez toga korisnik ne može doznati `chat.id` svoje grupe, a to je prvi podatak
  koji mu treba za `dopusteniChatovi`.

Nove rute:

```
GET  /api/telegram/ulaz/stanje   → { radi, offset, obradeno, preskoceno, zadnjaGreska, ts }
POST /api/telegram/ulaz/proba    → { ok, cekaPoruka, chatovi: [{ id, naziv, zadnjaPoruka }] }
```

Bez novih ključeva u `locales/hr.json` i `en.json` kartica ispisuje hrvatski tekst na
engleskom sučelju — isti kvar koji je TASK-4721 popravljao kod dežurnog (`zastoKey`).

---

## 8. Testovi (uvjet gotovosti)

Sve bez mreže: `getUpdates` i `fetch` prema ploči su **ubrizgani** (`api` argument), pa je
`jedanProlaz` čista funkcija nad ulaznim podatcima.

1. `update` bez teksta / bez `message` → preskočen, `offset` **ipak** pomaknut.
2. `offset` se pomiče i kad `POST /api/ingest` padne (§5.1) — dokaz „najviše jednom".
3. Filtri: chat izvan `dopusteniChatovi` → nema `POST`-a; `okidac` postavljen, poruka bez
   njega → nema `POST`-a.
4. Preslikavanje: `externalId === "<chat.id>:<message_id>"`, `source === 'telegram'`,
   i **nema** `projectId` u tijelu (§6).
5. `200 created:false` → **nijedna** poruka natrag u chat.
6. `201 created:true` + `potvrdaUChat` → točno jedna poruka, sadrži `taskId`.
7. `429` s `retry_after: 7` → sljedeći prolaz ne prije 7 s; `409` → petlja zaustavljena
   i stanje nosi razlog.
8. Brava: drugi poller uz živi PID u `.lock` → ne pokreće se, vraća jasan razlog.
9. Token nije postavljen → poller se uopće ne pokreće, bez ijedne greške u dnevniku
   (svježa instalacija je normalno stanje, ne kvar).

---

## 9. Odnos prema živoj instalaciji

Naš Klaudio (`~/.claude/tools/Telegram/telegram_agent.ts`) ostaje gdje jest — on radi puno
više od ulaza (razgovor, glas, kontekst razgovora, `chatContextTail`). Poller iz paketa
**ne** zamjenjuje njega, nego pokriva ono što tuđa instalacija treba: jedan smjer, jedan
`POST`, nula pretpostavki.

Kad se poller dokaže, živi most može prijeći na isti `POST /api/ingest` i time izgubiti
vlastitu kopiju pravila o pragovima — ali to je zaseban zadatak i **nije** u opsegu ovoga.
