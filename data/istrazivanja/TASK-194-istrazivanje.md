# Istraživanje: Sustav REGOČ i memorija (TASK-194)

## Datum
2026-10-06

## Projekt
PRJ-033 (Pretinac — zadatci bez projekta)

## Pitanje
Goran pita: "Pošalji mi na telegram grupu sve o sustavu regoč i da li imaš pristup memoriji i kojem tipu memorije?"

## Pronađene činjenice

### 1. Što je REGOČ
REGOČ = REsursni Gestor za Orkestraciju Članova. Meta-orkestrator PAI sustava.
Model: opus. Princip: Orchestrate, don't execute.

### 2. Agenti (11 + REGOČ)
| Agent | Model | Uloga |
|-------|-------|-------|
| REGOČ | opus | Orchestrator |
| Klaudio | sonnet | Telegram |
| Stribor | sonnet | TeamSpeak / glas |
| Kosjenka | opus | Arhitekt |
| Jelena | opus | Inženjer |
| Malik | opus | Sigurnost |
| Manda | opus | Istraživač |
| Dora | opus | Analitičar |
| Potjeh | sonnet | QA/Intern |
| Gita | sonnet | Umjetnik |
| Grga | opus | Dizajner |

### 3. Infrastruktura
| Servis | Adresa |
|--------|--------|
| TaskManager (SQL) | http://localhost:17781 |
| ChromaDB / RAG | 192.168.10.200:18765 (v2 API) |
| Ollama | 192.168.10.4:11434 |
| VoiceServer | localhost:8888 |
| STT Server | localhost:8787 |

### 4. Baze podataka
| Baza | Lokacija | Svrha |
|------|----------|-------|
| regoc.db | ~/.claude/regoc/data/regoc.db | Task management (tasks, projects, execution_queue, audit) — SQLite WAL, 11 tablica |
| messages.db | ~/.claude/regoc/messages.db | Inter-agent komunikacija (SQLite) |
| ChromaDB | 192.168.10.200:18765 | Vektorska baza za RAG (41 kolekcija) |

### 5. Tipovi memorije u sustavu

#### 5.1 RAG memorija (ChromaDB)
- Vektorska baza na 192.168.10.200:18765
- 41 kolekcija, uključujući:
  - agent_jelena, agent_kosjenka, agent_malik, agent_manda, agent_dora, agent_potjeh, agent_gita, agent_grga, agent_klaudio, agent_stribor, agent_emard (po agentu)
  - regoc_system_sesija, regoc_znanje, regoc_mobile (sustavske)
  - pai_learning_system, pai_sessions, pai_ratings (PAI opće)
  - hrvatski_pravopis (jezična)
  - FPGA, pcie, cubes, emc, presa, gladius, igor, dribler (projektne)
- Alati: rag-query.ts (čitanje), rag-store.ts (upis), rag-list.ts (popis)
- Embedding model: qwen3-embedding:8b (na Ollama 192.168.10.4)

#### 5.2 Datotečna memorija sesija (Claude Code)
- Lokacija: ~/.claude/projects/<hash-projekta>/memory/
- Piše je glavna sesija Claude Code
- Sadrži MEMORY.md indeks i pojedinačne .md datoteke
- Napomena: memorija stari, dio je zastario (vidi NESUKLADNOSTI.md)

#### 5.3 Hindsight memorija (shadow recall)
- Banka: regoc_opus_nodea
- Način: shadow (ne umeće se automatski u prompt, već se prikazuje kao podsjetnik)
- Servis: 127.0.0.1:17792/health
- Zapisuje činjenice s metapodacima (When, Involving, provjere nesukladnosti)
- Napomena: u trenutku provjere (TASK-163) servis je imao timeout (rok 5000 ms)

#### 5.4 SQLite memorija (TaskManager)
- regoc.db: 191 zadataka, 11 tablica (tasks, projects, execution_queue, task_history, knowledge, knowledge_relations, cost_log, settings, itd.)
- Audit trail kroz task_history tablicu
- Progress notes na zadacima (JSON array)

#### 5.5 Sistemska memorija (system-knowledge.json)
- Datoteka ~/.claude/regoc/system-knowledge.json
- Sadrži identitete agenata, pregled sustava, infrastrukturu
- Statična — ažurira se ručno

### 6. Pristup memoriji
Jelena (inženjer) ima pristup:
- RAG kolekciji agent_jelena (vlastita)
- RAG alatima: rag-query.ts, rag-store.ts, rag-list.ts
- Datotečnoj memoriji sesija (čitanje datoteka kroz read_file, grep)
- SQLite bazi regoc.db (kroz TaskManager API na portu 17781)
- Hindsight shadow memoriji (banka regoc_opus_nodea) — kroz sustavski blok u promptu

## Izvori
- ~/app/regoc_system/CLAUDE.md (v5.1.0)
- ~/app/regoc_system/GEMINI.md (v5.1.0, 29 pravila)
- ~/.claude/regoc/REGOC_AGENTS.json (v1.8.0)
- ~/.claude/regoc/system-knowledge.json
- ~/.claude/regoc/data/chroma_collections.json
- ~/.claude/regoc/data/regoc.db (SQLite, 191 zadatak)
- http://192.168.10.200:18765/api/v2/heartbeat (ChromaDB v2 — aktivan)
- http://192.168.10.4:11434/api/tags (Ollama — aktivan, qwen3-embedding:8b)

## Zapis odluke — Korak 2 (Istraživanje)
RAG je isključen na ovom čvoru (memory-config rag.enabled=false).
rag-store.ts vraća: "RAG isključen na ovom čvoru — rag-store.ts preskočen, nastavi bez RAG-a."
Istraživački dokument je spremljen lokalno: data/istrazivanja/TASK-194-istrazivanje.md
Ovo je ispod praga B (težina 26 < 36) — istraživanje je neobvezno, ali je napravljeno i dokumentirano.
