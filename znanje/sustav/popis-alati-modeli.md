# Alati domene modeli

Kanonski alati domene modeli. Prije pisanja nove skripte pokreni `katalog trazi <svrha>`; ako alat postoji, nadogradi ga.
- `AgentModel.ts` (modul, vlasnik jelena): AgentModel — JEDAN izvor istine za pitanje „koji model vozi ovaj agent". Poziv: `import iz ${SUSTAV_DIR}/models/AgentModel.ts`.
- `ClassifierModel.ts` (modul, vlasnik jelena): ClassifierModel — postavka „Klasifikacijski model". Poziv: `import iz ${SUSTAV_DIR}/models/ClassifierModel.ts`.
- `consult-potjeh.ts` (cli, vlasnik jelena): consult-potjeh — sinkroni "QA sparring" poziv Potjehu (lokalni model). Poziv: `bun ${SUSTAV_DIR}/tools/modeli/consult-potjeh.ts "opis problema + kontekst"`. Stare putanje: `${SUSTAV_DIR}/tools/consult-potjeh.ts`.
- `Inference.ts` (cli, vlasnik jelena): INFERENCE - Unified inference tool with three run levels. Poziv: `bun ${SUSTAV_DIR}/tools/modeli/Inference.ts --level fast <system_prompt> <user_prompt>`. Stare putanje: `~/.claude/skills/CORE/Tools/Inference.ts`.
- `ModelConfigWriter.ts` (cli, vlasnik jelena): ModelConfigWriter — JEDINI put kojim se `model-config.json` smije mijenjati. Poziv: `bun ${SUSTAV_DIR}/models/ModelConfigWriter.ts`.
- `ModelInterface.ts` (modul, vlasnik jelena): REGOČ Model Abstraction Layer — Core Interfaces. Poziv: `import iz ${SUSTAV_DIR}/models/ModelInterface.ts`.
- `ModelRouter.ts` (modul, vlasnik jelena): REGOČ ModelRouter — Intelligent Model Selection. Poziv: `import iz ${SUSTAV_DIR}/models/ModelRouter.ts`.
<!-- uvjet-redak: ollama --> - `ollama-agent.ts` (cli, vlasnik jelena): ollama-agent — agentski tool-loop runner za LOKALNE Ollama modele. Poziv: `bun ${SUSTAV_DIR}/tools/modeli/ollama-agent.ts --model qwen3-coder:30b --prompt-file /path/to/prompt.txt`. Stare putanje: `${SUSTAV_DIR}/tools/ollama-agent.ts`.
- `ollama-gpu-lock.ts` (modul, vlasnik jelena): ollama-gpu-lock — advisory lock za serijalizaciju pristupa lokalnom GPU-u. Poziv: `import iz ${SUSTAV_DIR}/tools/modeli/ollama-gpu-lock.ts`. Stare putanje: `${SUSTAV_DIR}/tools/ollama-gpu-lock.ts`.
- `openrouter-agent.ts` (cli, vlasnik jelena): openrouter-agent — agentski tool-loop runner za OpenRouter modele. Poziv: `bun ${SUSTAV_DIR}/tools/modeli/openrouter-agent.ts --model z-ai/glm-5.2 --prompt-file /path/to/prompt.txt`. Stare putanje: `${SUSTAV_DIR}/tools/openrouter-agent.ts`.
