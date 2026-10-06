# TASK-5297 — J10 na živom node-A (samo čitanje), 07.10.2026.

Alat `scripts/profil-cvora.ts` preko `--ssh` (sakupljač ide SSH standardnim ulazom, `bun run -`;
na čvoru ne nastaje ni jedna datoteka). Otisak čvora (`docs/qa/TASK-5295/otisak.sh`) prije = poslije
u svakom prolazu (`6605b0660f157bdf` = `6605b0660f157bdf`; nakon promjene na čvoru između prolaza
`de86c568f8d91388` = `de86c568f8d91388`).

```
bun scripts/profil-cvora.ts izvezi   --ssh <node-A> --instanca-van <tmp>/node-A.izvezeno.env   → j10_izvezi.txt  (exit 1)
bun scripts/profil-cvora.ts provjeri --ssh <node-A> --instanca <referentna instanca node-A>    → j10_provjeri.txt (exit 1)
```

* **provjeri: OK 93 · RAZLIKA 1 · NEDOSTAJE 0 · TAJNA-NEDOSTAJE 0 · PREDUVJET 0.**
* Jedina razlika: `razgovor.botKanal.ukljucen` profil=`true`, čvor=`false`. Nije kvar alata ni
  profila: `settings_history` na čvoru — 22:10:09Z `jelena-TASK-5290` upisala `true` (stanje
  u kojem je Kosjenka snimila profil, 73/73), 22:30:58Z `malik-TASK-5291 (sigurnosni pregled:
  uključuje vlasnik)` → `false`. Profil opisuje ciljno stanje; uključenje je vlasnikova odluka
  (alat ga ne smije donijeti), pa profil NIJE mijenjan.
* Izvedena instanca prema referentnoj (`node-A.instanca.env` na glavnom stroju): **15/17 iste**.
  Razlikuju se `CVOR_IME` (ime čvora se pojavljuje samo u `~/CLAUDE.md`, ne u postavkama) i
  `TUDI_HOME` (po definiciji ga na čvoru ne smije biti) — obje alat označava „nije izvedivo sa
  čvora". Izvedena instanca nije u paketu (ADR-0004 §7).
* Tajne: izlazi nose samo `TAJNA postoji …` (TELEGRAM_BOT_TOKEN, TM_CREDENTIALS,
  TM_BOT_KANAL_TOKEN, claude-prijava); grep oblika tokena (`\d{8,10}:…`, `sk-ant-`) = 0; jedini
  64-hex niz je javni sha256 kuke SecurityValidator (vrijednost instance po dizajnu).
