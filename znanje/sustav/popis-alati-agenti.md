# Alati domene agenti

Kanonski alati domene agenti. Prije pisanja nove skripte pokreni `katalog trazi <svrha>`; ako alat postoji, nadogradi ga.
- `ClaudeClient.ts` (cli, vlasnik jelena): ClaudeClient - Direct Claude API Integration for Telegram. Poziv: `bun ~/.claude/tools/Telegram/lib/ClaudeClient.ts`.
- `ClaudeCodeBridge.ts` (cli, vlasnik jelena): ClaudeCodeBridge - Claude Code CLI Integration Module. Poziv: `bun ~/.claude/tools/Telegram/lib/ClaudeCodeBridge.ts`.
- `config.ts` (modul, vlasnik jelena): Telegram Agent Configuration Loader. Poziv: `import iz ~/.claude/tools/Telegram/lib/config.ts`.
- `ConversationStore.ts` (cli, vlasnik jelena): ConversationStore - SQLite-based conversation history for Telegram. Poziv: `bun ~/.claude/tools/Telegram/lib/ConversationStore.ts`.
- `dezurni.ts` (modul, vlasnik jelena): dezurni.ts — most između Telegram agenta i dežurnog (rezervnog) modela. Poziv: `import iz ~/.claude/tools/Telegram/dezurni.ts`.
- `FileHandler.ts` (cli, vlasnik jelena): File Handler for Telegram Agent. Poziv: `bun ~/.claude/tools/Telegram/lib/FileHandler.ts`.
- `index.ts` (cli, vlasnik jelena): AgentBridge - Inter-agent communication system for REGOČ. Poziv: `bun ~/.claude/tools/AgentBridge/index.ts`.
- `KlaudioModel.ts` (modul, vlasnik jelena): KlaudioModel — prebacivanje modela za Klaudija (Telegram 24/7). Poziv: `import iz ~/.claude/tools/Telegram/lib/KlaudioModel.ts`.
- `MediaDatabase.ts` (modul, vlasnik jelena): MediaDatabase - Shared storage for Telegram media metadata. Poziv: `import iz ~/.claude/tools/Telegram/lib/MediaDatabase.ts`.
- `MessageQueue.ts` (modul, vlasnik jelena): MessageQueue — Per-Group Non-Blocking Message Queue. Poziv: `import iz ~/.claude/tools/Telegram/lib/MessageQueue.ts`.
- `RegocBridge.ts` (cli, vlasnik jelena): REGOČ Bridge for Telegram Agent (Klaudio). Poziv: `bun ~/.claude/tools/Telegram/lib/RegocBridge.ts`.
- `SendDoc.ts` (modul, vlasnik jelena): SendDoc — deterministicko slanje dokumenata iz Telegram agent pipelinea. Poziv: `import iz ~/.claude/tools/Telegram/lib/SendDoc.ts`.
- `SendTelegramResponse.ts` (cli, vlasnik jelena): SendTelegramResponse - Safely send response to Telegram relay. Poziv: `bun ~/.claude/tools/Telegram/SendTelegramResponse.ts "Your response text here"`.
- `SessionManager.ts` (modul, vlasnik jelena): SessionManager - Claude Code Session Persistence for REGOC Group. Poziv: `import iz ~/.claude/tools/Telegram/lib/SessionManager.ts`.
- `TaskCommands.ts` (modul, vlasnik jelena): ~/.claude/tools/Telegram/lib/TaskCommands.ts. Poziv: `import iz ~/.claude/tools/Telegram/lib/TaskCommands.ts`.
- `Telegram.ts` (cli, vlasnik jelena): CLI Telegram agenta Klaudija: start/stop/status agenta i ručno slanje iz konzole. Poziv: `bun ~/.claude/tools/Telegram/Telegram.ts start`.
- `telegram_agent.ts` (cli, vlasnik jelena): Klaudio - Telegram Voice & Text Agent. Poziv: `bun ~/.claude/tools/Telegram/telegram_agent.ts                # Run in foreground`.
- `TelegramBot.ts` (cli, vlasnik jelena): Telegram Bot Wrapper using grammY. Poziv: `bun ~/.claude/tools/Telegram/lib/TelegramBot.ts`.
- `TelegramMediaFetcher.ts` (cli, vlasnik jelena): TelegramMediaFetcher - Fetch and download media from Telegram chat history. Poziv: `bun ~/.claude/tools/Telegram/TelegramMediaFetcher.ts list [--chat ID] [--limit N]     List stored media`.
- `types.ts` (modul, vlasnik jelena): Telegram Agent Type Definitions. Poziv: `import iz ~/.claude/tools/Telegram/lib/types.ts`.
- `VoiceHandler.ts` (cli, vlasnik jelena): Voice Handler for Telegram Agent. Poziv: `bun ~/.claude/tools/Telegram/lib/VoiceHandler.ts`.
