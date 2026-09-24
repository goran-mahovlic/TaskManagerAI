/**
 * Ports — sve što jezgra orkestratora traži od domaćina (ADR-0001 §6).
 *
 * Ovo je stvarna granica podjele. Jezgra ne uvozi ništa iz nečije instalacije: ni bazu, ni
 * mapu s agentima, ni CLI. Sve nuspojave idu kroz sučelja niže, pa se cijeli orkestrator
 * može pokrenuti u testu s izvedbama u memoriji — bez ijedne datoteke i bez ijednog
 * mrežnog poziva. Test te granice je `tests/orchestrator.test.ts`.
 *
 * Pravilo koje ovo čuva: ako neka funkcija ne može raditi s lažnim portom, ona po
 * definiciji pripada domaćinu (adapteru), ne jezgri.
 *
 * Autorica: Jelena (Engineer), TASK-4800, po ADR-0001 (Kosjenka, TASK-4799).
 */

// ─── Ploča ───────────────────────────────────────────────────────────────────

export interface Task {
  id: string
  title: string
  description?: string
  status: string
  assignee?: string | null
  projectId?: string | null
  priority?: number
  tags?: string[]
  createdAt?: string
  startedAt?: string | null
}

export interface TaskPatch {
  status?: string
  assignee?: string | null
  resultSummary?: string
  blockedReason?: string
  progressNotes?: string[]
}

export interface CreateTaskInput {
  title: string
  description?: string
  assignee?: string | null
  projectId?: string | null
  priority?: number
  tags?: string[]
}

/**
 * Jedini put do zadataka. ADR-0001 L5: živi daemon na četiri mjesta otvara SQLite izravno i
 * time zaobilazi vlastiti REST API — jezgra to ne smije naslijediti, jer bi vezala oblik
 * baze uz orkestraciju.
 */
export interface Board {
  get(id: string): Promise<Task | null>
  list(status: string): Promise<Task[]>
  update(id: string, patch: TaskPatch): Promise<boolean>
  create(input: CreateTaskInput): Promise<{ id: string } | null>
  /** `in_progress` → `pending`, jedini dopušten povratak (ne PUT-om, v. TASK-3598). */
  reclaim(id: string, reason: string, by: string): Promise<boolean>
}

// ─── Red poruka ──────────────────────────────────────────────────────────────

export interface Origin {
  source?: string
  externalId?: string | number | null
  replyTo?: string | null
}

export interface Message {
  id: string
  from: string
  to: string
  content: string
  priority?: number
  createdAt?: string
  origin?: Origin
}

export interface MessageBus {
  pending(limit: number): Promise<Message[]>
  /** `true` = ova je petlja preuzela poruku; `false` = netko drugi je bio brži. */
  claim(id: string): Promise<boolean>
  complete(id: string): Promise<void>
  send(to: string, content: string, priority?: number, origin?: Origin): Promise<string>
}

// ─── Izvođač (ADR-0001 O4) ───────────────────────────────────────────────────

export interface ExecRequest {
  agentId: string
  model?: string
  prompt: string
  systemPrompt?: string
  sessionId?: string
  cwd?: string
  timeoutMs?: number
  /** ID zadatka — izvođač ga stavlja u okolinu agenta (TM_TASK_ID) za hook dodatnih uputa (TASK-5013). */
  taskId?: string
  /** Slobodna polja koja domaćin razumije (npr. dopuštenja alata). */
  extra?: Record<string, unknown>
}

export interface ExecResult {
  exitCode: number
  resultText: string
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
  sessionId?: string
  /** Broj poteza modela. `0` uz exit 0 = spawn je blokiran, NIJE uspjeh (TASK-2953). */
  numTurns?: number
  greska?: string
}

export interface Executor {
  ime: string
  run(req: ExecRequest): Promise<ExecResult>
}

// ─── Registar agenata (ADR-0001 O5) ──────────────────────────────────────────

export interface AgentInfo {
  id: string
  ime?: string
  uloga?: string
  model?: string
  /** Ključne riječi za rutiranje; `*` je catch-all. */
  keywords?: string[]
  rag?: string[]
  /** Izvođač iz `orchestrator.json → executors`; prazno = zadani. */
  executor?: string
}

export interface Ruta {
  agentId: string
  razlog: string
}

export interface AgentDirectory {
  list(): AgentInfo[]
  get(id: string): AgentInfo | null
  /** `null` = nijedan agent ne pokriva ovaj tekst → jezgra ne spawna ništa i to kaže. */
  route(tekst: string): Ruta | null
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

export interface PromptContext {
  task: Task
  agent: AgentInfo
  /** Adresa ploče koju vidi AGENT (može biti različita od one koju vidi jezgra, L3). */
  apiBaseUrl: string
  /** Rečenice o infrastrukturi koje je upisao KORISNIK. Jezgra svoje nema (S13). */
  systemFacts: string[]
  poruka?: Message
}

export interface PromptComposer {
  build(ctx: PromptContext): string
}

// ─── Ostalo ──────────────────────────────────────────────────────────────────

export interface LivenessProbe {
  ime: string
  alive(pid: number): boolean
  /** Mjera napretka (CPU jiffies) ili `null` gdje je nema — tada vrijedi samo `alive`. */
  progress(pid: number): number | null
}

export interface Notifier {
  notify(text: string, origin?: Origin): Promise<boolean>
}

export interface Clock { now(): number }
export interface Logger { log(redak: string): void }

/** Sve što jezgra treba. Ništa više, ništa manje. */
export interface OrchestratorPorts {
  board: Board
  bus: MessageBus
  executor: Executor
  agents: AgentDirectory
  prompt: PromptComposer
  liveness: LivenessProbe
  notifier: Notifier
  clock: Clock
  logger: Logger
}
