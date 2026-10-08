# TASK-5355 — deploy TASK-5352 na čvorove + rotacija TM_BOT_KANAL_TAJNA_* (08.10.2026.)

## 1. Deploy main 7b6f62b (tm-cvor-azuriraj.sh svi, ~09:58Z)
Bundle iz čistog klona main-a (paket na glavnom ima tuđe nepraćene docs/qa/TASK-5349 → skripta odbija).

| čvor | prije → poslije | MainPID | provjere |
|---|---|---|---|
| node-A 192.168.10.20 | fc06fdd4 → 7b6f62bb | 1071681 → 1082225 | StaleCodeCheck 0, bootcheck M1–M4 PASS, zadaci 283=283 |
| node-B 192.168.10.11 | ba9e17a6 → 7b6f62bb | 133355 → 138937 | StaleCodeCheck 0, bootcheck M1–M4 PASS, zadaci 24=24 |

Posljedica: node-A gubi TASK-5346/5354 (Config „jedna skupina = jedan Spremi"; TASK-5346 je blocked i nije u mainu).
Kopija starog stanja: node-A `~/backup/taskmanagerai/20261008_095834/`.

## 2. Rupa zatvorena (s LAN-a, 192.168.10.200)
POST /api/konzola/exec {"command":"whoami"}:
- bez zaglavlja: .20 → 403, .11 → 403
- X-TM-Konzola:1: .20 → 403, .11 → 403
- X-TM-Konzola:1 + Host:localhost + X-Forwarded-For:127.0.0.1: .20 → 403, .11 → 403

## 3. Rotacija (10:03Z) — par Klaudio (glavni) ↔ Šaban (node-A); node-B nema tajni kanala
Nove 64-hex vrijednosti (secrets.token_hex), na čvor preko stdin-a ssh-a, atomski zapis 0600.

| smjer | glavni (Telegram config/.env) | node-A (config/postavke.env) |
|---|---|---|
| K→S | SLANJE sha256:2c6f8d8ecfa6 | PRIMANJE sha256:2c6f8d8ecfa6 |
| S→K | PRIMANJE sha256:0fabbe1ca228 | SLANJE sha256:0fabbe1ca228 |

Stari otisci (966048b9d197 / d982466be343) više nisu nigdje.
node-A ploča restartana 1082225 → 1083756 (StaleCodeCheck 0); Klaudio čita tajne po mtime (bez restarta).
E2E: potpisani GET /api/razgovor/od-bota/stanje prema node-A novom tajnom → 200, krivom → 401.
Otisci: `python3 ~/.claude/regoc/tools/tajne/secret_probe.py --prefix TM_BOT_KANAL_` (novo: --prefix/--store).

## 4. Otvoreno (Goran)
- Exec pozivi se nisu logirali (journal ima samo baner) → zloupotreba se ne može isključiti.
- Ručno rotirati: TELEGRAM_BOT_TOKEN (BotFather /revoke) Šabana i bota node-B, EMAIL_PASSWORD na čvorovima,
  ključeve davatelja u okolini/spremištu čvorova — sve je bilo čitljivo s LAN-a do 09:58Z.
