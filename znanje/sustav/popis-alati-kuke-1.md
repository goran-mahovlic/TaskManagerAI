# Alati domene kuke (dio 1)

Kanonski alati domene kuke, dio 1. Prije pisanja nove skripte pokreni `katalog trazi <svrha>`; ako alat postoji, nadogradi ga.
- `AgentMemoryRead.hook.ts` (hook, vlasnik jelena): AgentMemoryRead.hook.ts - Load Agent Context from Vector Memory (PreToolUse). Poziv: `kuka (settings.json) — bun ~/.claude/hooks/AgentMemoryRead.hook.ts`.
- `AgentMemoryWrite.hook.ts` (hook, vlasnik jelena): AgentMemoryWrite.hook.ts - Store Agent Outputs to Vector Memory (SubagentStop). Poziv: `kuka (settings.json) — bun ~/.claude/hooks/AgentMemoryWrite.hook.ts`.
- `AgentOutputCapture.hook.ts` (hook, vlasnik jelena): AgentOutputCapture.hook.ts - Capture Subagent Results (SubagentStop). Poziv: `kuka (settings.json) — bun ~/.claude/hooks/AgentOutputCapture.hook.ts`.
- `AutoWorkCreation.hook.ts` (hook, vlasnik jelena): AutoWorkCreation.hook.ts - Automatic Work Directory Creation (UserPromptSubmit). Poziv: `kuka (settings.json) — bun ~/.claude/hooks/AutoWorkCreation.hook.ts`.
- `capture.ts` (hook, vlasnik jelena): capture.ts - Response capture handler. Poziv: `kuka (settings.json) — bun ~/.claude/hooks/handlers/capture.ts`.
- `change-detection.ts` (hook, vlasnik jelena): change-detection.ts - Utilities for detecting REGOČ system changes. Poziv: `kuka (settings.json) — bun ~/.claude/hooks/lib/change-detection.ts`.
- `CheckAgentRequests.hook.ts` (hook, vlasnik jelena): CheckAgentRequests Hook - Monitors for REGOČ requests from agents. Poziv: `kuka (settings.json) — bun ~/.claude/hooks/CheckAgentRequests.hook.ts`.
- `CheckRegocQueue.hook.ts` (hook, vlasnik jelena): CheckRegocQueue.hook.ts - REGOČ Message Queue Hook. Poziv: `kuka (settings.json) — bun ~/.claude/hooks/UserPromptSubmit/CheckRegocQueue.hook.ts`.
- `CheckTelegramRelay.hook.ts` (hook, vlasnik jelena): CheckTelegramRelay Hook. Poziv: `kuka (settings.json) — bun ~/.claude/hooks/UserPromptSubmit/CheckTelegramRelay.hook.ts`.
- `CheckVersion.hook.ts` (hook, vlasnik jelena): CheckVersion.hook.ts - Check for Claude Code Updates (SessionStart). Poziv: `kuka (settings.json) — bun ~/.claude/hooks/CheckVersion.hook.ts`.
- `CheckVoiceRelay.hook.ts` (hook, vlasnik jelena): CheckVoiceRelay Hook. Poziv: `kuka (settings.json) — bun ~/.claude/hooks/UserPromptSubmit/CheckVoiceRelay.hook.ts`.
- `ContextCapture.hook.ts` (hook, vlasnik jelena): ContextCapture.hook.ts. Poziv: `kuka (settings.json) — bun ~/.claude/hooks/ContextCapture.hook.ts`.
- `ContextExport.hook.ts` (hook, vlasnik jelena): ContextExport.hook.ts. Poziv: `kuka (settings.json) — bun ~/.claude/hooks/ContextExport.hook.ts`.
- `ContextRefresh.cron.ts` (hook, vlasnik jelena): ContextRefresh.cron.ts. Poziv: `bun ~/.claude/hooks/ContextRefresh.cron.ts`.
- `EnsureRegocDaemon.hook.ts` (hook, vlasnik jelena): REGOČ Daemon Startup Hook. Poziv: `kuka (settings.json) — bun ~/.claude/hooks/EnsureRegocDaemon.hook.ts`.
- `ExplicitRatingCapture.hook.ts` (hook, vlasnik jelena): ExplicitRatingCapture.hook.ts - Capture Explicit User Ratings (UserPromptSubmit). Poziv: `kuka (settings.json) — bun ~/.claude/hooks/ExplicitRatingCapture.hook.ts`.
- `FormatEnforcer.hook.ts` (hook, vlasnik jelena): FormatEnforcer.hook.ts - Response Format Injection (UserPromptSubmit). Poziv: `kuka (settings.json) — bun ~/.claude/hooks/FormatEnforcer.hook.ts`.
- `IdealState.ts` (hook, vlasnik jelena): Ideal State Utilities. Poziv: `kuka (settings.json) — bun ~/.claude/hooks/lib/IdealState.ts`.
- `identity.ts` (hook, vlasnik jelena): Central Identity Loader. Poziv: `kuka (settings.json) — bun ~/.claude/hooks/lib/identity.ts`.
- `ImplicitSentimentCapture.hook.ts` (hook, vlasnik jelena): ImplicitSentimentCapture.hook.ts - Implicit Sentiment Detection (UserPromptSubmit). Poziv: `kuka (settings.json) — bun ~/.claude/hooks/ImplicitSentimentCapture.hook.ts`.
- `KatalogCuvar.hook.ts` (hook, vlasnik jelena): PreToolUse uz Write nove .py/.ts/.sh u tools/ ili ~/.tmp: pretraži katalog i upozori „postoji sličan alat X — nadogradi ga”; fail-open, ≤300 ms. Poziv: `kuka (settings.json PreToolUse Write) — ručno: echo '<json>' | bun ~/.claude/hooks/KatalogCuvar.hook.ts`.
- `learning-utils.ts` (hook, vlasnik jelena): Shared Learning Utilities. Poziv: `kuka (settings.json) — bun ~/.claude/hooks/lib/learning-utils.ts`.
- `LoadContext.hook.ts` (hook, vlasnik jelena): LoadContext.hook.ts - Inject CORE Skill into Claude's Context (SessionStart). Poziv: `kuka (settings.json) — bun ~/.claude/hooks/LoadContext.hook.ts`.
- `LoadDomainContext.hook.ts` (hook, vlasnik jelena): LoadDomainContext.hook.ts - Load domain context on keyword detection. Poziv: `kuka (settings.json) — bun ~/.claude/hooks/UserPromptSubmit/LoadDomainContext.hook.ts`.
