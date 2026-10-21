# TASK-5349 — QA node-A: Šaban odgovara iz banke (savjet/* iz TASK-5341), privatno 0 (08.10.2026.)

## 1. Pitanja Šabanu (izvan doslovnog teksta Klaudijeva odgovora)

`pitaj_sabana.ts` na node-A: isporučeni kod (`~/TaskManagerAI` @ dce0ea3), ŽIVE postavke razgovora
(Šaban, memorija `on`, banka `cvor_node_a`, ovlasti `puno`), pravi `claude -p`, pravi Hindsight, agenti i
upute čvora. Kanal lažan (ništa ne ide u grupu); trag ide na PRAVU ploču node-A kroz HTTP API.
Svako pitanje je zaseban chat. Puni izlaz: `proba.out`, `ishod.json` (s memorijskim blokom).

| # | Pitanje | Ploča node-A | 💬 bilješka | Bit odgovora | Ocjena |
|---|---|---|---|---|---|
| P1 | Kako se šalje datoteka u grupu? | TASK-290 ✅ | 10,6 s · 🧠 21 | oznaka SEND_DOC + apsolutna putanja + `\|` opis, samo iz radne mape, kanal uklanja oznaku, pad → razlog u chat | prolaz (uglate zagrade ne imenuje — Identitet mu brani pisati oznaku doslovno) |
| P2 | „putanja nije apsolutna"? a `(( ))`? | TASK-291 ✅ | 10,4 s · 🧠 18 | prepoznata, treba `/`, bez `~`; `(( ))` regex ne prepozna, ostaje tekst, BEZ greške; ispravno uglate | prolaz |
| P3 | Odakle ti token za slanje? | TASK-292 ✅ | 15,5 s · 🧠 20 | kanal ploče šalje tokenom OVOG bota iz konfiguracije kanala; on ga ne čita | prolaz |
| P4 | Audio izvještaj? „nema venva"? | TASK-293 ✅ | 11,2 s · 🧠 18 | `scripts/glas x.md -o /aps/x.mp3` hr_regoc → JSON `send_doc` → redak u odgovor; „nema venva" → `instaliraj-glas.sh` (`--suho`); glas samo u potezu čovjeka | prolaz (izlaz 3 ne spominje) |

Izvor činjenica u memorijskom bloku (`izvor_cinjenica.py`, recall kroz posrednik 17795 → `document_id`):

| | redaka u bloku | iz savjet/* | ostalo |
|---|---|---|---|
| P1 | 10 | 7 (send-doc 5, glas 1, bot-kanal 1) | sustav/telegram-sesija, sustav/tijekovi-mehanizmi, alati/glas |
| P2 | 9 | 8 (send-doc 5, glas 3) | sustav/telegram-sesija |
| P3 | 10 | 10 (send-doc 9, bot-kanal 1) | — |
| P4 | 10 | 10 (glas 10) | — |

## 2. Privatno

`bun docs/qa/TASK-5331/mjeri_curenje.ts --url http://127.0.0.1:17795 --privatno <popis> --banka cvor_node_a --iskljuci PRJ-001,PRJ-002,PRJ-033`
→ `upita 90, izraza s privatnom činjenicom 0` (projekt 0/67, klijent 0/10, osoba 0/4, usluga 0/9), exit 0, 2 min 59 s.

## 3. Klaudijev novi odgovor → bilješka „🧠 znanje od Klaudija…" + `savjet.log`

NIJE ispitano: grana TASK-5341 (804bef2, 3ab6107) nije u `main`, Klaudio PID 589902 radi od 07.10. 20:52
(prije izmjena `telegram_agent.ts` 08.10. 07:48 UTC), `~/.claude/tools/Telegram/data/znanje-cvoru/` ne postoji.
Restart ide kroz `restart_kad_mirno.sh`, koji čeka da nema zadataka u radu.

## Nalaz N1 — memorijski blok Šabanu pokazuje `((SEND_DOC: … ]]`

Banka čuva ispravno `[[SEND_DOC: … | …]]` (recall izravno: 11 činjenica s `[[`). Ali `Memorija.ts` svaki redak
pušta kroz `neutralizirajTekst` (`Ciscenje.ts`, TASK-5279), koji `[` ispred `[SEND_DOC` mijenja u `(`, pa model
u istom bloku vidi `((SEND_DOC: /apsolutna/putanja | opis]]` I činjenicu „oznaka s `(( ))` se ne prepozna".
To je vjerojatan izvor Šabanove izvorne greške (okrugle zagrade, TASK-5341). U ovoj probi model je ipak
odgovorio ispravno (P2), jer Identitet navodi pravi oblik. Prijedlog: neutralizacija da ne proizvodi
oblik koji izgleda kao (pogrešna) oznaka, npr. opisni zamjenski tekst `‹SEND_DOC-oznaka›`, ili uz blok
napomena da je `((` posljedica neutralizacije.

Usputno: `memory_unit_count` dokumenata u API-ju je 25/25/25 (Jelena je javila 32/29/28 činjenica).
Moguće je da API broji jedinice drugačije od ispisa sastavljača; to nisam dalje ispitivao.

## Točka 3 — Klaudijev novi odgovor Šabanu → banka cvor_node_a (08.10. 09:47–09:52 UTC)

- Klaudio PID 1306086 (start 08.10. 09:24 UTC), StaleCodeCheck: kod na disku == kod u pogonu.
- `ZnanjeCvoru` zove `scripts/savjet-cvoru.ts` iz main checkouta (`grupe.json → botKanal.znanje.paket`), a grana TASK-5341 nije bila u mainu → spojena (0fb7a1b, bun test 1917 pass / 0 fail).
- Pitanje: Šaban → Klaudio LAN-om s node-A (`pitaj_klaudija.ts`, isporučeni `stvoriBotKanal`, žive postavke, HMAC) → `poslano` (pitaj_klaudija.out).
- Klaudio: bot-ulaz 485a97cb odgovoreno; `[ZNANJE-ČVORU] savjet → banka cvor_node_a (pid 1332699)`.
- savjet.log: `paket sastavljen (236s) … 39 činjenica` · `filtar: 39 ulazi, 0 izbačeno` · **`OK savjet/glas → cvor_node_a (65.7s)`** · `trag: TASK-299 ← bilješka (http 200)`.
- Ploča node-A TASK-299 (tagovi razgovor, chat:telegram:-1001234567890): bilješka **„🧠 znanje od Klaudija upisano u banku cvor_node_a: „glas — …" (savjet/glas, 39 činjenica)"**.
- Curenje nakon upisa: 0/90.
- Nalaz N2: u istom chatu Šaban je vlasniku (TASK-299, 09:43) rekao da su normalizacija i naglasna priprema uključene, a Klaudio (09:47) da ih na node-A još nema (TASK-5340). Jedan od njih nema točne činjenice o node-A; nisam provjeravao koji (izvan opsega).
