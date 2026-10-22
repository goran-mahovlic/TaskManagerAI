#!/usr/bin/env bun
/**
 * REGOČ System Awareness Block (A2)
 *
 * Generates a compact (~1000 token) block injected into every agent prompt
 * so they know about the REGOČ system, team, rules, and communication channels.
 *
 * Location: ~/.claude/regoc/SystemAwarenessBlock.ts
 *
 * Usage:
 *   import { getSystemAwarenessBlock } from '~/.claude/regoc/SystemAwarenessBlock'
 *   const sab = getSystemAwarenessBlock()
 *   const block = sab.generate('jelena')
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const REGOC_DIR = join(process.env.HOME ?? homedir(), '.claude', 'regoc')
const AGENTS_JSON = join(REGOC_DIR, 'REGOC_AGENTS.json')

/** Role descriptions for the team table */
const ROLE_HELP_MAP: Record<string, string> = {
  regoc: 'orkestracija, koordinacija',
  klaudio: '24/7 komunikacija',
  stribor: 'glasovna komunikacija',
  kosjenka: 'arhitektura, dizajn sustava',
  jelena: 'implementacija, TypeScript',
  malik: 'sigurnost, audit, pentest',
  manda: 'istraživanje, dokumentacija',
  dora: 'analiza, multi-perspektiva',
  potjeh: 'testiranje, verifikacija',
  gita: 'vizualizacije, generativna umjetnost',
  grga: 'UI/UX, frontend dizajn',
  emard: 'Verilog, FPGA debug',
}

interface AgentEntry {
  id: string
  name: string
  role: string
  model: string
  visibility?: string
  security_isolation?: boolean
}

interface AgentsJson {
  _meta: { version: string }
  agents: Record<string, AgentEntry>
}

export class SystemAwarenessBlock {
  private agentsData: AgentsJson | null = null

  /** Load agents JSON, cached after first read */
  private loadAgents(): AgentsJson {
    if (this.agentsData) return this.agentsData
    const raw = readFileSync(AGENTS_JSON, 'utf-8')
    this.agentsData = JSON.parse(raw) as AgentsJson
    return this.agentsData
  }

  /**
   * Generate a compact awareness block for an agent.
   * Max ~1000 tokens. Contains: identity, team, rules, communication, tools.
   */
  /**
   * R1b/TASK-4431: `ctx` nosi projekt i zadatak da primjer upisa u RAG bude izvediv.
   * Do sada je blok učio oblik `-m '{...}'` koji od R1 (TASK-4308) PADA na vrataru sheme.
   * NAPOMENA: ovaj sastavljač NIJE na živom putu (RegocDaemon ga ne uvozi) — ispravlja se
   * da prestane biti izvor krive upute za onoga tko ga jednom uključi.
   */
  generate(agentId: string, ctx: { projectId?: string | null; taskId?: string | null } = {}): string {
    const data = this.loadAgents()
    const self = data.agents[agentId]
    if (!self) {
      throw new Error(`Agent '${agentId}' not found in REGOC_AGENTS.json`)
    }

    const isIsolated = self.security_isolation === true

    // Build team table — filter based on who is requesting
    const teamRows: string[] = []
    for (const [id, agent] of Object.entries(data.agents)) {
      // Skip REGOC orchestrator from team list (mentioned separately)
      if (id === 'regoc') continue
      // Skip self from team list
      if (id === agentId) continue
      // Secret agents: only visible to themselves (already skipped above)
      if (agent.visibility === 'secret' && id !== agentId) continue

      const helpText = ROLE_HELP_MAP[id] ?? agent.role
      teamRows.push(`| ${agent.name} | ${agent.role} | ${helpText} |`)
    }

    const teamTable = `| Agent | Uloga | Za pomoć u |
|-------|-------|-----------|
${teamRows.join('\n')}`

    // Build the block
    const sections: string[] = []

    // Header
    sections.push(`## REGOČ SUSTAV v4.4.0
Ti si **${self.name}** (${self.role}) u REGOČ sustavu — REsursni Gestor za Orkestraciju Članova.
Orchestrator: REGOČ (opus) | Princip: Orchestrate, don't execute`)

    // Team
    sections.push(`### TIM (${teamRows.length + 2} agenata)
${teamTable}`)

    // Rules
    sections.push(`### KLJUČNA PRAVILA
1. **VERIFICATION GATE** — Prije DONE: IDENTIFY→RUN→READ→VERIFY→CLAIM
1b. **RUN = i DEPLOY** — Popravak na disku ≠ popravak u pogonu. Ako kod vrti dugotrajan
   proces (daemon/server/worker), nije DONE dok proces nije restartan i provjeren:
   bun ~/.claude/regoc/StaleCodeCheck.ts --entry <fajl> --pid <pid>   (exit 3 = stari kod)
2. **STRUCTURED STATUS** — Koristi: [TASK_DONE:X], [TASK_BLOCKED:X], [TASK_NEEDS_CONTEXT:X]
3. **RAG-FIRST** — Pretraži RAG prije "ne znam"
4. **TEST BEFORE DONE** — NIKAD pretpostavljaj da radi!
5. **ANTI-RATIONALIZATION** — Nema izgovora za preskakanje testova`)

    // Communication — omit sensitive details for isolated agents
    if (isIsolated) {
      sections.push(`### KOMUNIKACIJA
- **MessageQueue:** messages.db (SQLite) — inter-agent komunikacija
- **Pošalji poruku:** INSERT INTO messages (id,from_agent,to_agent,content,message_type,priority,status,created_at) VALUES (...)
- **Help request:** Ako zapneš, pošalji help_request → REGOČ će spawnati helper agenta
- **Direct ask:** Možeš direktno pitati peer agenta (message_type='direct_ask')
- **Signali:** Provjeri agent_signals/${agentId}.jsonl za BTW poruke`)
    } else {
      sections.push(`### KOMUNIKACIJA
- **MessageQueue:** ~/.claude/regoc/messages.db (SQLite)
- **Pošalji poruku:** INSERT INTO messages (id,from_agent,to_agent,content,message_type,priority,status,created_at) VALUES (...)
- **Help request:** Ako zapneš, pošalji help_request → REGOČ će spawnati helper agenta
- **Direct ask:** Možeš direktno pitati peer agenta (message_type='direct_ask')
- **Signali:** Provjeri ~/.tmp/agent_signals/${agentId}.jsonl za BTW poruke`)
    }

    // Logging — omit paths for isolated agents
    if (isIsolated) {
      sections.push(`### LOGIRANJE
- Sve spremi u RAG kolekciju agent_${agentId}
- Progress notes: ažuriraj TaskManager svakih 5 min`)
    } else {
      const prj = ctx.projectId?.trim() || '<ključ projekta s ploče>'
      const tsk = ctx.taskId?.trim() || '<TASK-oznaka>'
      sections.push(`### LOGIRANJE
- Sve spremi u RAG: bun ~/.claude/skills/CORE/Tools/rag-store.ts -c agent_${agentId} -t "..." -p ${prj} --type nalaz --task ${tsk}
- Zastavice -p / --type (istrazivanje|odluka|nalaz|spec|lekcija) / --task su OBVEZNE — bez njih upis pada
- Progress notes: ažuriraj TaskManager svakih 5 min`)
    }

    return sections.join('\n\n')
  }
}

let _instance: SystemAwarenessBlock | null = null

export function getSystemAwarenessBlock(): SystemAwarenessBlock {
  if (!_instance) {
    _instance = new SystemAwarenessBlock()
  }
  return _instance
}
