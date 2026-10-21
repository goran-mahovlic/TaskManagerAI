# TASK-5337 — SEND_DOC iz privitaka chata, trag razgovora na ploči čvora (07.10.2026.)

## Uzrok (izmjereno na node-A, zapis razgovora grupe, 20:01:32 UTC)

Oznaku `[[SEND_DOC: …]]` jezgra je prepoznala i maknula iz teksta, ali odbila slanje:
`📎 dokument nije poslan: izvan dopuštene mape`. Bot je xlsx spremio u `privitci/<chat>`, a
dopuštena je bila samo radna mapa `data/razgovor/radni/telegram_<chat>`. Identitet mu nije rekao
koja je to mapa. Dvije dodatne oznake iz objašnjenja formata („primjer”) također su obrađene kao
slanje (`putanja nije apsolutna`, `datoteka ne postoji`).

Konzola: retci razgovora išli su samo živim WebSocketom (`broadcastKonzola`) i nigdje se nisu
spremali. Razgovor bot↔bot nije otvarao zadatak, pa na ploči nije bilo traga.

## Popravak u paketu (`03038be`)

| Što | Gdje |
|---|---|
| SEND_DOC smije i iz `privitci/<chatId>` TOG chata (tuđi chat se odbija) | `Razgovor.ts` `dokumentiMapeChata`, `TaskWebUI.ts` |
| Identitet navodi stvarne mape i kaže da oznaka nije primjer | `Identitet.ts` |
| Neuspjeh slanja → razlog u chat (`HTTP 400: …`, bez tokena) | `Kanal.posaljiDokumentIshod`, `TelegramPoller.ts` |
| Trag razgovora: zadatak niti (bez nositelja, `razgovor`+`no-autonomy`), bilješke 📥 ⚙️ 💬 📤 👁 ✅ ⌛ | `ZadatakRazgovora.ts`, `RazgovorPloca.ts` |
| Konzola razgovora trajno u `data/razgovor/konzola.log`, `logs razgovor N`, zadnjih 30 pri otvaranju | `Zapis.ts`, `TaskWebUI.ts` |
| Slanje iz ljuske tokenom bota OVE instalacije | `scripts/posalji-dokument.ts` |

Testovi: `tests/razgovor-zadatak.test.ts` 16 pass; cijeli paket 1670 pass, 0 fail.

## Primjena na node-A

* Kopija prije: `~/backup/task5337_20261007_162509/prije.tgz` (vrijeme čvora, EDT).
* NALAZ: radno stablo paketa na čvoru bilo je od 10:45 na grani `zadatak/TASK-194` (agent je
  napravio checkout i ostavio ga). Ta grana nosi samo `data/` izlaze, ali je bez koda TASK-5300/5305,
  pa je prvi restart (PID 911417) učitao stariji kod: bot-potez je pao s `model_not_found`
  (`anthropic:opus` predan CLI-ju bez skidanja providera). Stablo je vraćeno na `main` (`a0fb05e7`),
  zakrpa primijenjena bez sukoba (`592e4e6d`), razgovorne datoteke md5 = paket.
* Restart ploče kad je `in_progress = 0`: PID 912985, 22:30:14 CEST, `StaleCodeCheck` exit 0.
* `bun scripts/posalji-dokument.ts --suho` s okolinom ploče: token čvora postoji, chat dopušten (exit 0).

## Dokaz isporuke

* Klaudio → Šaban (grupa + LAN kanal, HTTP 202) → Šabanov potez 15,9 s, `📎 1`.
* `privitci/<grupa>/evidencija.jsonl`: `smjer: poslano, vrsta: document, poruka: 273,
  tko: @regoc_saban_bot, izvor: …/ulx5m-gs_pinout.xlsx` — `message_id` iz `ok` odgovora Bot API-ja.
* Ploča node-A: TASK-274 (prvi pokušaj: 📥 → ⚙️ → ⚠ kvar izvršitelja), TASK-275 (📥 → ⚙️ → 💬 → ✅).

## Suhi prolaz na node-B (samo čitanje)

`profil-cvora.ts primijeni --suho` i `provjeri --json` (profil `upravitelj-cvora` + `instanca.primjer.env`):
`razgovor.dokumenti` **OK** (SEND_DOC uključen u postavkama). Dvije nove stavke profila (TASK-5337) su
**PREDUVJET**: kod node-B je `3e58905`, pa ih nema. Treba ga ažurirati (`tm-cvor-azuriraj.sh`), a za to
treba vlasnikovo odobrenje. Otisak prije = poslije (`nodeB_otisak.txt`), dakle ništa nije promijenjeno.
Puni izlaz: `nodeB_primijeni_suho.txt`.
