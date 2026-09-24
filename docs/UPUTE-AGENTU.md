# Dodatne upute agentu dok radi

Agent koji radi na zadatku (`claude --print`) opis zadatka dobiva jednom, pri pokretanju.
Ono što poslije dopišeš u bilješke zadatka ne vidi. Uputa (TASK-5013) je poruka koja stiže
**u sesiju koja već radi**: agent ne treba pauzu ni ponovno pokretanje, pa ne gubi kontekst.

## Kako se šalje

- **Ploča:** gumb 📨 na kartici zadatka, ili polje „Dodatne upute agentu” u detaljima.
- **API:**

```bash
curl -X POST http://localhost:17781/api/tasks/TASK-123/uputa \
  -H 'Content-Type: application/json' \
  -d '{"text":"Promjena plana: …","author":"ana"}'
```

| Metoda | Put | Svrha |
|---|---|---|
| `POST` | `/api/tasks/:id/uputa` | nova uputa `{text, author?}` → `201`; prazna ili dulja od 4000 znakova → `400`; zadatak `completed`/`cancelled` → `409` |
| `GET` | `/api/tasks/:id/upute[?nedostavljene=1]` | popis s `delivered_at` i `delivered_session` |
| `GET` | `/api/upute/stanje` | brojači za cijelu ploču `{TASK-x: {total, undelivered}}` |
| `POST` | `/api/tasks/:id/upute/preuzmi` | **samo za hook**: atomično vrati nedostavljene upute i označi ih kao dostavljene |

Upute su u tablici `task_instructions`, odvojeno od `progress_notes`. Bilješke piše i sam
agent, pa bi se uputa među njima izgubila. U bilješke idu samo tragovi „📨 čeka” i „📬 dostavljena”.

## Kako stiže do agenta

1. Izvođač (`src/core/orchestrator/Executors.ts`) agentu u okolinu stavlja `TM_TASK_ID`.
2. Claude Code hook `hooks/TaskInstructionsInject.hook.ts` radi na događajima **PostToolUse**
   (nakon svakog alata) i **SessionStart** (pri pokretanju). Preuzme nedostavljene upute i vrati ih kao
   `hookSpecificOutput.additionalContext`. Model ih vidi uz rezultat svog sljedećeg alata.
3. Agent potvrđuje primitak u sljedećoj bilješci: „uputa #N primljena”.
4. **Rezerva:** ako agent završi prije nego što uputa stigne, ona ostaje nedostavljena. Sljedeći
   agent na istom zadatku dobiva je u SessionStart, u početnom kontekstu.

**Fail-open:** kad ploča ne radi, ne odgovori u 300 ms ili vrati neispravan odgovor, hook izlazi
s kodom 0 i ništa ne ispisuje. Alat radi dalje, a uputa ostaje za sljedeći pokušaj. Bez `TM_TASK_ID`
hook izlazi odmah (~50 ms), pa ne smeta u interaktivnim sesijama.

## Registracija hooka (`~/.claude/settings.json`)

```json
{
  "hooks": {
    "PostToolUse":  [{ "hooks": [{ "type": "command", "timeout": 5,
      "command": "bun run /PUTANJA/DO/TaskManagerAI/hooks/TaskInstructionsInject.hook.ts" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "timeout": 5,
      "command": "bun run /PUTANJA/DO/TaskManagerAI/hooks/TaskInstructionsInject.hook.ts" }] }]
  }
}
```

Adresa ploče: `TM_URL`, inače `http://localhost:${TM_PORT:-17781}`.

## Ograničenja

- Uputa stiže uz **sljedeći** alat. Dok traje dug alat (npr. `sleep 600`), uputa čeka da on završi.
  Agent koji samo piše tekst bez alata dobiva je tek pri sljedećem pokretanju.
- Dostavu imaju samo izvođači koji učitavaju Claude Code hookove. Za HTTP izvođač (Ollama/OpenAI)
  vrijedi samo rezerva: uputa ostaje nedostavljena dok zadatak ne preuzme agent s hookom.
