/**
 * ⚠️ NAPUŠTENO (DEPRECATED) — ADR-0004, odluka O3, 3. 9. 2026.
 *
 * Ovaj sastavljač prompta NIJE pozvan ni iz jednog daemona (jedine pojave izvan datoteke su
 * tests/unified-spawn.test.ts, popis za StaleCodeCheck i ploča). Živi put je
 * RegocDaemon.buildAgentPrompt() + AgentDaemon.buildPrompt(), oboje preko IdentityBlock.ts
 * kao jedinog izvora identiteta. Ne uvoditi ga natrag bez izmjene ADR-a — drugi put kroz
 * gradnju prompta znači drugo mjesto na kojem se propis razilazi od pogona.
 *
 * Kod se NE briše: buildVerificationBlock() ostaje IZVOR teksta za verification_gate +
 * anti_rationalization + structured_status, koji se u živi put prenosi u TASK-3669.
 * Odluka: ~/app/regoc_system/docs/ADR-0004-identitet-agenta-pri-spawnu.md
 *
 * UnifiedSpawnPipeline.ts — Constructs COMPLETE agent prompts by assembling
 * all context layers in the correct order.
 *
 * (POVIJESNA NAMJERA, nikad provedena — v. oznaku napuštenosti gore:)
 * This was meant to replace the ad-hoc buildAgentPrompt() in RegocDaemon.ts that skips
 * checkpoint, identity, system awareness, verification gate, anti-rationalization,
 * structured status, and proper RAG instructions.
 *
 * Sections assembled IN ORDER:
 *   1. CHECKPOINT block (MUST be FIRST — Pravilo #11)
 *   2. Identity block from REGOC_AGENTS.json
 *   3. REGOC System Awareness (compact, ~800 tokens)
 *   4. Required knowledge from required_knowledge array
 *   5. RAG pre-work instructions
 *   6. Verification gate + Anti-rationalization + Structured status
 *   7. TASK (the actual assignment)
 *
 * @version 1.0.0
 */

import { readFileSync, existsSync } from "fs";
import { sanitizeForIsolation } from "./IdentityBlock";
import { buildVerificationBlock, LEGACY_PARTS } from "./SpawnVerificationBlock";
import { join } from "path";
import { homedir } from 'os'

const HOME = process.env.HOME || homedir();
const AGENTS_JSON_PATH = join(HOME, ".claude/regoc/REGOC_AGENTS.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnConfig {
  agentId: string;           // 'jelena', 'kosjenka', etc
  taskId: string;            // 'TASK-430'
  taskTitle: string;
  taskDescription: string;
  fromAgent: string;         // who requested
  ragHints?: string[];       // extra collections to search
  projectContext?: string;   // additional project-specific context
  /** R1b/TASK-4431: ključ projekta s ploče — ulazi u primjer `rag-store.ts -p …`. */
  projectId?: string | null;
}

interface AgentEntry {
  id: string;
  name: string;
  full_name: string;
  role: string;
  model: string;
  skills?: string[];
  tools?: string[] | Record<string, unknown>;
  communication_style?: string;
  required_knowledge?: string[];
  context_file?: string | null;
  security_isolation?: boolean;
  security_isolation_note?: string;
  description?: string;
}

interface AgentRegistry {
  agents: Record<string, AgentEntry>;
  rag_collections: Record<string, string>;
  rag_related_agents: Record<string, string[]>;
  spawn_template: {
    verification_gate: { prompt_injection: string };
    anti_rationalization: { prompt_injection: string };
    structured_status: { prompt_injection: string };
    zod_verification: { prompt_injection: string };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a required_knowledge path to an absolute filesystem path.
 */
function resolveKnowledgePath(relativePath: string): string {
  if (relativePath.startsWith("skills/")) {
    return join(HOME, ".claude", relativePath);
  }
  if (relativePath.startsWith("regoc_system/")) {
    return join(HOME, "app", relativePath);
  }
  if (relativePath.startsWith("HDL-GuideLines/") || relativePath.startsWith("PDP1_info/")) {
    return join(HOME, "fpga-AI-projects/ulx3s", relativePath);
  }
  // Fallback: CLAUDE.md, SNOWFLAKE_WORKFLOW.md etc for Emard
  if (!relativePath.includes("/")) {
    return join(HOME, "app/regoc_system", relativePath);
  }
  return relativePath;
}

/**
 * Read a file and truncate to ~tokenLimit tokens (approximation: 1 token ~ 4 chars).
 */
function readFileTruncated(path: string, charLimit: number = 2000): string {
  try {
    if (!existsSync(path)) return `<!-- File not found: ${path} -->`;
    const content = readFileSync(path, "utf-8");
    if (content.length <= charLimit) return content;
    return content.substring(0, charLimit) + "\n\n... (truncated)";
  } catch {
    return `<!-- Error reading: ${path} -->`;
  }
}

/**
 * Build compact agent list for system awareness block.
 */
function buildCompactAgentList(agents: Record<string, AgentEntry>): string {
  const lines: string[] = [];
  for (const [id, agent] of Object.entries(agents)) {
    if (id === "_meta") continue;
    // @ts-ignore visibility is optional
    if (agent.visibility === "secret") continue; // Don't leak secret agents
    lines.push(`- **${agent.name}** (${agent.model}) — ${agent.role}`);
  }
  return lines.join("\n");
}

// I9/TASK-3658: redakcija za `security_isolation` živi u `IdentityBlock.ts` — jedan izvor
// istine za oba puta (blok identiteta na sistemskom kanalu i ovaj prompt). Dvije kopije
// znače da jedna zaostane, a zaostala redakcija je gora od nikakve jer izgleda kao da radi.

// ---------------------------------------------------------------------------
// UnifiedSpawnPipeline
// ---------------------------------------------------------------------------

export class UnifiedSpawnPipeline {
  private registry: AgentRegistry;

  constructor(registry?: AgentRegistry) {
    if (registry) {
      this.registry = registry;
    } else {
      const raw = readFileSync(AGENTS_JSON_PATH, "utf-8");
      this.registry = JSON.parse(raw);
    }
  }

  /**
   * Build complete agent prompt with all context layers.
   * Returns markdown string ready for claude --print -p
   */
  buildPrompt(config: SpawnConfig): string {
    const agent = this.registry.agents[config.agentId];
    if (!agent) {
      throw new Error(`Unknown agent: ${config.agentId}. Available: ${Object.keys(this.registry.agents).filter(k => k !== '_meta').join(", ")}`);
    }

    const isIsolated = agent.security_isolation === true;
    const sections: string[] = [];

    // --- Section 1: CHECKPOINT (MUST be FIRST) ---
    sections.push(this.buildCheckpoint(config, agent));

    // --- Section 2: Identity ---
    sections.push(this.buildIdentity(agent));

    // --- Section 3: System Awareness ---
    sections.push(this.buildSystemAwareness(isIsolated));

    // --- Section 4: Required Knowledge ---
    const knowledgeSection = this.buildRequiredKnowledge(agent, isIsolated);
    if (knowledgeSection) sections.push(knowledgeSection);

    // --- Section 5: RAG instructions ---
    sections.push(this.buildRAGInstructions(config, isIsolated));

    // --- Section 6: Verification + Anti-rationalization + Structured status ---
    sections.push(this.buildVerificationBlock());

    // --- Section 7: TASK ---
    sections.push(this.buildTask(config));

    let prompt = sections.join("\n\n---\n\n");

    // Apply security isolation filtering as final pass
    if (isIsolated) {
      prompt = sanitizeForIsolation(prompt);
    }

    return prompt;
  }

  // ---------------------------------------------------------------------------
  // Section builders
  // ---------------------------------------------------------------------------

  private buildCheckpoint(config: SpawnConfig, agent: AgentEntry): string {
    const agentName = agent.name;
    return `## CHECKPOINT -- ${agentName}
- Task: ${config.taskTitle} (${config.taskId})
- Status: in_progress
- Provjeri REGOC poruke:
\`\`\`bash
bun ~/.claude/regoc/tools/agent-mq.ts check --agent ${config.agentId}
\`\`\`
- Provjeri peer poruke:
\`\`\`bash
sqlite3 ~/.claude/regoc/messages.db "SELECT id,from_agent,subject,created_at FROM messages WHERE to_agent='${config.agentId}' AND status='pending' ORDER BY priority DESC LIMIT 5;"
\`\`\``;
  }

  private buildIdentity(agent: AgentEntry): string {
    const skillsList = Array.isArray(agent.skills) ? agent.skills.join(", ") : "N/A";
    return `## AGENT IDENTITY
AGENT: ${agent.full_name}
ROLE: ${agent.role}
MODEL: ${agent.model}
STYLE: ${agent.communication_style || "profesionalan"}
SKILLS: ${skillsList}`;
  }

  private buildSystemAwareness(isIsolated: boolean): string {
    const agentList = buildCompactAgentList(this.registry.agents);

    let awareness = `## REGOC SUSTAV (v4.4.0)
Ti si dio REGOC sustava -- 12 specijaliziranih agenata:
${agentList}

Kljucna pravila:
1. Verification gate: IDENTIFY -> RUN -> READ -> VERIFY -> CLAIM
1b. RUN ukljucuje DEPLOY: popravak u kodu NIJE done dok proces koji ga vrti nije
    restartan i provjeren (bun/node ne ucitavaju kod ponovno). Provjera:
    bun ~/.claude/regoc/StaleCodeCheck.ts --entry <fajl> --pid <pid> (exit 3 = stari kod)
2. Structured status: [TASK_DONE:X] / [TASK_BLOCKED:X] / [TASK_NEEDS_CONTEXT:X]
3. RAG-first: bun ~/.claude/skills/CORE/Tools/rag-query.ts -c pai_learning_system -q "..." -n 5
4. Test before done: NIKAD ne pretpostavljaj!
5. Ako zapnes: posalji help_request u MessageQueue`;

    if (isIsolated) {
      awareness += `\n\nNAPOMENA: Ti si u SECURITY ISOLATION modu. Nemas pristup IP adresama, portovima, ni credential informacijama.`;
    }

    return awareness;
  }

  private buildRequiredKnowledge(agent: AgentEntry, isIsolated: boolean): string | null {
    if (!agent.required_knowledge || agent.required_knowledge.length === 0) {
      return null;
    }

    const lines: string[] = ["## POTREBNO ZNANJE\n"];

    for (const knowledgePath of agent.required_knowledge) {
      const absPath = resolveKnowledgePath(knowledgePath);
      let content = readFileTruncated(absPath, 2000); // ~500 tokens

      if (isIsolated) {
        content = sanitizeForIsolation(content);
      }

      lines.push(`### ${knowledgePath}\n`);
      lines.push(content);
      lines.push("");
    }

    return lines.join("\n");
  }

  private buildRAGInstructions(config: SpawnConfig, isIsolated: boolean): string {
    const collection = this.registry.rag_collections[config.agentId] || `agent_${config.agentId}`;
    const searchTerm = config.taskTitle;

    let ragBlock = `## RAG MEMORIJA
Prije rada pretrazi:
\`\`\`bash
bun ~/.claude/skills/CORE/Tools/rag-query.ts -c ${collection} -q "${searchTerm}" -n 5
\`\`\`
\`\`\`bash
bun ~/.claude/skills/CORE/Tools/rag-query.ts -c pai_learning_system -q "${searchTerm}" -n 5
\`\`\``;

    // Add ragHints collections
    if (config.ragHints && config.ragHints.length > 0) {
      for (const hint of config.ragHints) {
        if (hint !== collection && hint !== "pai_learning_system") {
          ragBlock += `\n\`\`\`bash
bun ~/.claude/skills/CORE/Tools/rag-query.ts -c ${hint} -q "${searchTerm}" -n 5
\`\`\``;
        }
      }
    }

    ragBlock += `\n
Nakon rada spremi:
\`\`\`bash
bun ~/.claude/skills/CORE/Tools/rag-store.ts -c ${collection} -t "${config.taskId} - ${config.taskTitle}" -p ${config.projectId || "<ključ projekta s ploče>"} --type nalaz --task ${config.taskId}
\`\`\``;

    if (isIsolated) {
      ragBlock = sanitizeForIsolation(ragBlock);
    }

    return ragBlock;
  }

  private buildVerificationBlock(): string {
    // TASK-3669 (ADR-0004 O3): sastavljač je PRENESEN u ./SpawnVerificationBlock.ts, koji
    // vozi živi put. Ovdje ostaje samo poziv — da tekst ne postoji na dva mjesta.
    return buildVerificationBlock(this.registry.spawn_template, LEGACY_PARTS);
  }

  private buildTask(config: SpawnConfig): string {
    let taskBlock = `## ZADATAK

${config.taskDescription}`;

    if (config.projectContext) {
      taskBlock += `\n\n### Dodatni kontekst projekta\n${config.projectContext}`;
    }

    if (config.fromAgent) {
      taskBlock += `\n\nZadatak od: **${config.fromAgent}**`;
    }

    taskBlock += `\n\nSalji: [TASK_DONE:${config.taskId}] kad zavrsis s verification evidencom.`;

    return taskBlock;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: UnifiedSpawnPipeline | null = null;

export function getUnifiedSpawnPipeline(): UnifiedSpawnPipeline {
  if (!_instance) {
    _instance = new UnifiedSpawnPipeline();
  }
  return _instance;
}

// ---------------------------------------------------------------------------
// CLI usage
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.log("Usage: bun UnifiedSpawnPipeline.ts <agentId> <taskId> <taskTitle> [taskDescription]");
    console.log("Example: bun UnifiedSpawnPipeline.ts jelena TASK-430 'Implement auth' 'Add JWT auth to API'");
    process.exit(1);
  }

  const [agentId, taskId, taskTitle, ...descParts] = args;
  const taskDescription = descParts.join(" ") || taskTitle;

  const pipeline = getUnifiedSpawnPipeline();
  const prompt = pipeline.buildPrompt({
    agentId,
    taskId,
    taskTitle,
    taskDescription,
    fromAgent: "regoc",
  });

  console.log(prompt);
}
