#!/usr/bin/env bun
/**
 * REGOC CostTracker (F5.2, prošireno K7/TASK-2986)
 *
 * API token usage and cost tracking per agent/task.
 * Uses SQLite table `cost_log` in regoc.db.
 *
 * Cost rates (USD per 1M tokens) — usklađeno s `tools/run_tokens.py` (K6) da se ista
 * potrošnja ne prikazuje dvjema različitim cijenama:
 *   opus:   input=5,    output=25,   cache_read=0.5,  cache_write=6.25
 *   sonnet: input=3,    output=15,   cache_read=0.3,  cache_write=3.75
 *   haiku:  input=1,    output=5,    cache_read=0.1,  cache_write=1.25
 *   gpt-4o: input=2.5,  output=10
 *   gemini-2.5-pro: input=1.25, output=10
 *   Default (local/ollama): 0
 *
 * VAŽNO: tarifa je PROCJENA. Kad `claude --print --output-format json` javi
 * `total_cost_usd`, to je mjerenje i ima prednost (SpawnTelemetry prosljeđuje `costUsd`).
 * Mjereno 28.07.: 1-satni cache upis naplaćuje se 2× ulaz, a ne 1,25× — tarifna procjena
 * zato podcjenjuje runove s velikim cache-writeom.
 *
 * Cache je ~97 % prometa, pa se `cache_read_tokens`/`cache_write_tokens` bilježe odvojeno;
 * `session_id` povezuje redak s transkriptom u `~/.claude/projects/`.
 *
 * ── Z10/TASK-3011: `turns`, `cache_hit_ratio`, potrošnja po projektu ────────────────
 *
 * `turns` — broj krugova runa (`num_turns` iz JSON omotnice). NULL znači „nije javljeno",
 * ne 0: nula bi lagala da je run bio bez ijednog kruga.
 *
 * `cache_hit_ratio` NIJE stupac nego izvedena vrijednost u pogledu `v_cost_log`:
 *   cache_read / (cache_read + input)
 * Obrazloženje (Jelena): omjer je čista funkcija dvaju postojećih stupaca. Spremljen kao
 * stupac bio bi denormalizacija koja drifta (ispravak tokena bez ispravka omjera) i bio bi
 * NULL za sve već zapisane retke; pogled ga računa i unatrag, a na redu veličine 10⁴ redaka
 * je besplatan. Isto vrijedi za agregate — omjer se računa iz SUM-ova, nikad kao AVG omjera.
 *
 * POTROŠNJA PO PROJEKTU IDE JOIN-om `cost_log.task_id → tasks.project_id`, a ne kopijom
 * `project_id` u `cost_log`. Kopija bi se zamrznula u trenutku spawna: kad backfill kasnije
 * dodijeli projekt zadatku, stari cost-redci ostali bi krivi zauvijek. JOIN je samoizlječiv.
 * Stupac `cost_log.project_id` postoji SAMO za retke bez `task_id` (npr. slobodni spawnovi),
 * i `logUsage` ga namjerno ignorira kad je `taskId` zadan.
 *
 * Usage:
 *   import { getCostTracker } from './src/core/CostTracker'
 *   const ct = getCostTracker()
 *   ct.logUsage({ agentId: 'assistant', taskId: 'TASK-100', model: 'opus', inputTokens: 5000, outputTokens: 2000, turns: 12 })
 *   ct.getCostByAgent()
 *   ct.getCostByProject(7)   // potrošnja po projektu, zadnjih 7 dana
 */

import Database from 'bun:sqlite'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { TM_DB, konfigPutanja } from './paths'

// ============================================
// Types
// ============================================

export interface CostEntry {
  timestamp: string
  agentId: string
  taskId: string | null
  model: string
  inputTokens: number
  outputTokens: number
  /** Predmemorirani ulaz (10× jeftiniji od ulaza) — ~97 % prometa. */
  cacheReadTokens: number
  /** Upis u predmemoriju (skuplji od ulaza). */
  cacheWriteTokens: number
  /** `session_id` spawna → poveznica na transkript u `~/.claude/projects/`. */
  sessionId: string | null
  /** `num_turns` iz omotnice; NULL = pozivatelj ga nije javio (stara verzija pisca). */
  turns: number | null
  /** Projekt SAMO za retke bez `task_id`; inače se čita JOIN-om na `tasks`. */
  projectId: string | null
  costUsd: number
}

/** Potrošnja jednog projekta u prozoru od N dana (rezultat JOIN-a na `tasks`). */
export interface ProjectUsageRow {
  /** `null` = nepripisano (zadatak bez projekta ili spawn bez zadatka). */
  projectId: string | null
  projectName: string | null
  spawns: number
  /** Zbroj `turns`; retci bez javljenih turnova doprinose 0. */
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** cache_read / (cache_read + input) nad zbrojevima; `null` kad je nazivnik 0. */
  cacheHitRatio: number | null
  costUsd: number
}

/** Agregat po modelu u obliku koji troši konzola (isti ključevi kao stari `stats-cache.json`). */
export interface ModelUsageRow {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUSD: number
  spawns: number
}

// ============================================
// Cost Rates (USD per 1M tokens)
// ============================================

interface ModelRate {
  input: number       // USD per 1M input tokens
  output: number      // USD per 1M output tokens
  cacheRead: number   // USD per 1M cache-read tokens
  cacheWrite: number  // USD per 1M cache-write tokens
}

const COST_RATES: Record<string, ModelRate> = {
  // A6/TASK-3005: `fable` je SKUPLJI od opusa (2× po svakoj osi), nije jeftiniji tier.
  // Bez ovog retka `normalizeModel('claude-fable-5')` nije pogađao ništa i tarifa je
  // vraćala 0 — Jelenini fable runovi bi se u procjeni vodili kao besplatni. Mjereni
  // runovi (`cost_source: 'cli'`) time nisu bili pogođeni, ali procjena jest.
  fable:              { input: 10,   output: 50,   cacheRead: 1.0,  cacheWrite: 12.5 },
  opus:               { input: 5,    output: 25,   cacheRead: 0.5,  cacheWrite: 6.25 },
  sonnet:             { input: 3,    output: 15,   cacheRead: 0.3,  cacheWrite: 3.75 },
  haiku:              { input: 1,    output: 5,    cacheRead: 0.1,  cacheWrite: 1.25 },
  'gpt-4o':           { input: 2.5,  output: 10,   cacheRead: 0.25, cacheWrite: 3.125 },
  'gemini-2.5-pro':   { input: 1.25, output: 10,   cacheRead: 0.125, cacheWrite: 1.5625 },
}

const ZERO_RATE: ModelRate = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

// ============================================
// Pogledi (Z10/TASK-3011)
// ============================================

/**
 * `v_cost_log` = `cost_log` + izvedeni `cache_hit_ratio`. Vrijednost se NE sprema u tablicu
 * (v. zaglavlje); pogled je računa i za retke zapisane prije ovog zadatka.
 * Nazivnik `cache_read + input` je „koliko je ulaznog konteksta uopće bilo"; kad je 0
 * (npr. lokalni model bez tokena), omjer je NULL, ne 0 — 0 bi značilo „nijedan pogodak".
 */
const COST_LOG_VIEW_SQL = `CREATE VIEW v_cost_log AS
SELECT id, timestamp, agent_id, task_id, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       session_id, turns, project_id, cost_usd,
       CASE WHEN (COALESCE(cache_read_tokens, 0) + COALESCE(input_tokens, 0)) > 0
            THEN CAST(COALESCE(cache_read_tokens, 0) AS REAL)
                 / (COALESCE(cache_read_tokens, 0) + COALESCE(input_tokens, 0))
            ELSE NULL
       END AS cache_hit_ratio
FROM cost_log`

/** Usporedba definicija pogleda otporna na razmake/prijelome retka. */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/** SQL izraz za omjer nad ZBROJEVIMA (nikad AVG omjera — to bi krivo težilo male runove). */
const CACHE_HIT_RATIO_AGG = `CASE WHEN SUM(COALESCE(c.cache_read_tokens, 0) + COALESCE(c.input_tokens, 0)) > 0
        THEN CAST(SUM(COALESCE(c.cache_read_tokens, 0)) AS REAL)
             / SUM(COALESCE(c.cache_read_tokens, 0) + COALESCE(c.input_tokens, 0))
        ELSE NULL END`

// ============================================
// CostTracker
// ============================================

export class CostTracker {
  private db: Database

  constructor(dbPath?: string) {
    // ADR-0001 O1.1: baza je uvijek TM_DB (zadano $HOME/.taskmanager/data/tasks.db).
    const defaultPath = TM_DB
    this.db = new Database(dbPath || defaultPath)
    this.db.exec("PRAGMA journal_mode = WAL"); this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec('PRAGMA journal_mode = WAL')
    this.initSchema()
  }

  // --- Public API ---

  /**
   * Zabilježi potrošnju jednog runa.
   *
   * `costUsd` je opcionalan: kad ga pozivatelj zna iz CLI-ja (`total_cost_usd`), to je
   * MJERENJE i upisuje se doslovno; inače se računa po tarifi.
   *
   * `turns` je opcionalan i ostaje NULL kad ga pozivatelj ne javi — stari pisci (SpawnTelemetry
   * prije Z10) tako i dalje rade, samo bez tog mjerenja.
   *
   * `projectId` se upisuje SAMO kad nema `taskId`. Kad zadatak postoji, on je izvor istine i
   * projekt se čita JOIN-om (v. `getCostByProject`), pa se proslijeđeni `projectId` namjerno
   * odbacuje umjesto da se zamrzne kriva vrijednost.
   */
  logUsage(
    entry: Omit<CostEntry, 'timestamp' | 'costUsd' | 'cacheReadTokens' | 'cacheWriteTokens' | 'sessionId' | 'turns' | 'projectId'>
      & Partial<Pick<CostEntry, 'cacheReadTokens' | 'cacheWriteTokens' | 'sessionId' | 'costUsd' | 'turns' | 'projectId'>>,
  ): void {
    const cacheRead = entry.cacheReadTokens ?? 0
    const cacheWrite = entry.cacheWriteTokens ?? 0
    const costUsd = entry.costUsd ?? this.calculateCost(entry.model, entry.inputTokens, entry.outputTokens, cacheRead, cacheWrite)
    const id = randomUUID()
    const projectId = entry.taskId ? null : (entry.projectId ?? null)

    this.db.prepare(`
      INSERT INTO cost_log (id, agent_id, task_id, model, input_tokens, output_tokens,
                            cache_read_tokens, cache_write_tokens, session_id, cost_usd,
                            turns, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, entry.agentId, entry.taskId, entry.model, entry.inputTokens, entry.outputTokens,
           cacheRead, cacheWrite, entry.sessionId ?? null, costUsd,
           entry.turns ?? null, projectId)
  }

  getTotalCost(options?: { agentId?: string; from?: string; to?: string }): number {
    let sql = 'SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_log WHERE 1=1'
    const params: unknown[] = []

    if (options?.agentId) {
      sql += ' AND agent_id = ?'
      params.push(options.agentId)
    }
    if (options?.from) {
      sql += ' AND timestamp >= ?'
      params.push(options.from)
    }
    if (options?.to) {
      sql += ' AND timestamp <= ?'
      params.push(options.to)
    }

    const row = this.db.prepare(sql).get(...params) as { total: number }
    return row.total
  }

  getCostByAgent(): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT agent_id, COALESCE(SUM(cost_usd), 0) as total
      FROM cost_log
      GROUP BY agent_id
      ORDER BY total DESC
    `).all() as Array<{ agent_id: string; total: number }>

    const result: Record<string, number> = {}
    for (const row of rows) {
      result[row.agent_id] = row.total
    }
    return result
  }

  getCostByDay(days: number = 30): Array<{ date: string; cost: number }> {
    const rows = this.db.prepare(`
      SELECT DATE(timestamp) as date, COALESCE(SUM(cost_usd), 0) as cost
      FROM cost_log
      WHERE timestamp >= datetime('now', ? || ' days')
      GROUP BY DATE(timestamp)
      ORDER BY date DESC
    `).all(`-${days}`) as Array<{ date: string; cost: number }>

    return rows
  }

  getStats(): { totalCostUsd: number; totalTokens: number; totalCacheReadTokens: number; totalCacheWriteTokens: number; totalTurns: number; cacheHitRatio: number | null; byAgent: Record<string, number>; byModel: Record<string, number> } {
    // `totalTokens` namjerno ostaje ulaz+izlaz (naplativa "prava" potrošnja);
    // cache se prikazuje odvojeno jer bi inače progutao sve ostalo (~97 % prometa).
    const overallRow = this.db.prepare(`
      SELECT
        COALESCE(SUM(c.cost_usd), 0) as totalCost,
        COALESCE(SUM(c.input_tokens + c.output_tokens), 0) as totalTokens,
        COALESCE(SUM(c.cache_read_tokens), 0) as totalCacheRead,
        COALESCE(SUM(c.cache_write_tokens), 0) as totalCacheWrite,
        COALESCE(SUM(c.turns), 0) as totalTurns,
        ${CACHE_HIT_RATIO_AGG} as cacheHitRatio
      FROM cost_log c
    `).get() as { totalCost: number; totalTokens: number; totalCacheRead: number; totalCacheWrite: number; totalTurns: number; cacheHitRatio: number | null }

    const byAgent = this.getCostByAgent()

    const modelRows = this.db.prepare(`
      SELECT model, COALESCE(SUM(cost_usd), 0) as total
      FROM cost_log
      GROUP BY model
      ORDER BY total DESC
    `).all() as Array<{ model: string; total: number }>

    const byModel: Record<string, number> = {}
    for (const row of modelRows) {
      byModel[row.model] = row.total
    }

    return {
      totalCostUsd: overallRow.totalCost,
      totalTokens: overallRow.totalTokens,
      totalCacheReadTokens: overallRow.totalCacheRead,
      totalCacheWriteTokens: overallRow.totalCacheWrite,
      totalTurns: overallRow.totalTurns,
      cacheHitRatio: overallRow.cacheHitRatio,
      byAgent,
      byModel,
    }
  }

  close(): void {
    this.db.close()
  }

  // --- Internal ---

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cost_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        agent_id TEXT NOT NULL,
        task_id TEXT,
        model TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0
      )
    `)

    // K7/TASK-2986: stupci dodani naknadno — migracija mora proći i na postojećoj bazi.
    // SQLite nema `ADD COLUMN IF NOT EXISTS`, pa se popis stupaca prvo pročita.
    const existing = new Set(
      (this.db.prepare(`SELECT name FROM pragma_table_info('cost_log')`).all() as Array<{ name: string }>)
        .map((r) => r.name),
    )
    const additions: Array<[string, string]> = [
      ['cache_read_tokens', 'INTEGER DEFAULT 0'],
      ['cache_write_tokens', 'INTEGER DEFAULT 0'],
      ['session_id', 'TEXT'],
      // Z10/TASK-3011 — oba bez DEFAULT-a: NULL znači „nije mjereno", 0 bi bilo mjerenje.
      ['turns', 'INTEGER'],
      ['project_id', 'TEXT'],
    ]
    for (const [col, decl] of additions) {
      if (!existing.has(col)) this.db.exec(`ALTER TABLE cost_log ADD COLUMN ${col} ${decl}`)
    }

    // Index for common queries
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_log_agent ON cost_log(agent_id)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_log_timestamp ON cost_log(timestamp)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_log_model ON cost_log(model)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_log_task ON cost_log(task_id)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_log_project ON cost_log(project_id)`)

    this.ensureView('v_cost_log', COST_LOG_VIEW_SQL)
  }

  /**
   * Uskladi pogled s definicijom u kodu (kod je SSOT). Stupci se navode poimence — `SELECT *`
   * bi se u pogledu proširio na buduće stupce i tiho mijenjao ugovor prema potrošačima.
   * DROP+CREATE ide u transakciji da paralelni čitač ne uhvati trenutak bez pogleda.
   */
  private ensureView(name: string, sql: string): void {
    const row = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?`).get(name) as
      | { sql: string }
      | undefined
    if (row && normalizeSql(row.sql) === normalizeSql(sql)) return

    this.db.transaction(() => {
      this.db.exec(`DROP VIEW IF EXISTS ${name}`)
      this.db.exec(sql)
    })()
  }

  /** Postoji li tablica (JOIN na `tasks` mora preživjeti samostalnu cost-bazu, npr. u testovima). */
  private hasTable(name: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)
  }

  // --- Agregati za konzolu (17781) ---

  /** Potrošnja po modelu — zamjena za `modelUsage` iz mrtvog `stats-cache.json`. */
  getUsageByModel(days: number = 30): Record<string, ModelUsageRow> {
    const rows = this.db.prepare(`
      SELECT model,
             COALESCE(SUM(input_tokens), 0)       AS inp,
             COALESCE(SUM(output_tokens), 0)      AS out,
             COALESCE(SUM(cache_read_tokens), 0)  AS cread,
             COALESCE(SUM(cache_write_tokens), 0) AS cwrite,
             COALESCE(SUM(cost_usd), 0)           AS cost,
             COUNT(*)                             AS spawns
      FROM cost_log
      WHERE timestamp >= datetime('now', ? || ' days')
      GROUP BY model
      ORDER BY cost DESC
    `).all(`-${days}`) as Array<{ model: string; inp: number; out: number; cread: number; cwrite: number; cost: number; spawns: number }>

    const result: Record<string, ModelUsageRow> = {}
    for (const r of rows) {
      result[r.model] = {
        inputTokens: r.inp,
        outputTokens: r.out,
        cacheReadInputTokens: r.cread,
        cacheCreationInputTokens: r.cwrite,
        costUSD: r.cost,
        spawns: r.spawns,
      }
    }
    return result
  }

  /** Dnevni tokeni po modelu — zamjena za `dailyModelTokens`. */
  getDailyTokens(days: number = 30): Array<{ date: string; tokensByModel: Record<string, number> }> {
    const rows = this.db.prepare(`
      SELECT DATE(timestamp) AS date, model,
             COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens
      FROM cost_log
      WHERE timestamp >= datetime('now', ? || ' days')
      GROUP BY DATE(timestamp), model
      ORDER BY date ASC
    `).all(`-${days}`) as Array<{ date: string; model: string; tokens: number }>

    const byDate = new Map<string, Record<string, number>>()
    for (const r of rows) {
      const bucket = byDate.get(r.date) || {}
      bucket[r.model] = (bucket[r.model] || 0) + r.tokens
      byDate.set(r.date, bucket)
    }
    return [...byDate.entries()].map(([date, tokensByModel]) => ({ date, tokensByModel }))
  }

  /** Broj spawnova / različitih sesija / zadataka u prozoru — brojke za "System overview". */
  getSpawnCounts(days: number = 30): { spawns: number; sessions: number; tasks: number; lastAt: string | null } {
    const row = this.db.prepare(`
      SELECT COUNT(*)                    AS spawns,
             COUNT(DISTINCT session_id)  AS sessions,
             COUNT(DISTINCT task_id)     AS tasks,
             MAX(timestamp)              AS lastAt
      FROM cost_log
      WHERE timestamp >= datetime('now', ? || ' days')
    `).get(`-${days}`) as { spawns: number; sessions: number; tasks: number; lastAt: string | null }
    return row
  }

  /**
   * Potrošnja po projektu u zadnjih `days` dana — odgovor na „koliko me košta PRJ-021".
   *
   * Projekt se izvodi kao `COALESCE(tasks.project_id, cost_log.project_id)`: prvo pita zadatak
   * (samoizlječivo — backfill projekta retroaktivno preseli i stare cost-retke), a stupac u
   * `cost_log` služi samo retcima bez zadatka. `projectId: null` = nepripisano.
   */
  getCostByProject(days: number = 7): ProjectUsageRow[] {
    const rows = this.db.prepare(this.projectUsageSql()).all(`-${days}`) as Array<{
      projectId: string | null; projectName: string | null; spawns: number; turns: number
      inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number
      cacheHitRatio: number | null; costUsd: number
    }>
    return rows
  }

  /** Isti agregat za jedan projekt (prazan redak kad projekt nema potrošnje u prozoru). */
  getProjectUsage(projectId: string, days: number = 7): ProjectUsageRow {
    const found = this.getCostByProject(days).find((r) => r.projectId === projectId)
    if (found) return found
    return {
      projectId, projectName: null, spawns: 0, turns: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      cacheHitRatio: null, costUsd: 0,
    }
  }

  /**
   * SQL za „potrošnja po projektu, N dana". Odvojeno da se može ispisati i pokrenuti ručno
   * (`bun -e` / DB alat) bez instanciranja klase — mjerenje mora biti provjerljivo izvana.
   * JOIN-ovi se izostavljaju kad tablice ne postoje (samostalna cost-baza).
   */
  projectUsageSql(): string {
    const hasTasks = this.hasTable('tasks')
    const hasProjects = this.hasTable('projects')
    const project = hasTasks ? `COALESCE(t.project_id, c.project_id)` : `c.project_id`

    return `
      SELECT ${project}                                        AS projectId,
             ${hasProjects ? 'p.name' : 'NULL'}                AS projectName,
             COUNT(*)                                          AS spawns,
             COALESCE(SUM(c.turns), 0)                         AS turns,
             COALESCE(SUM(c.input_tokens), 0)                  AS inputTokens,
             COALESCE(SUM(c.output_tokens), 0)                 AS outputTokens,
             COALESCE(SUM(c.cache_read_tokens), 0)             AS cacheReadTokens,
             COALESCE(SUM(c.cache_write_tokens), 0)            AS cacheWriteTokens,
             ${CACHE_HIT_RATIO_AGG}                            AS cacheHitRatio,
             COALESCE(SUM(c.cost_usd), 0)                      AS costUsd
      FROM cost_log c
      ${hasTasks ? 'LEFT JOIN tasks t ON t.id = c.task_id' : ''}
      ${hasProjects ? `LEFT JOIN projects p ON p.id = ${project}` : ''}
      WHERE c.timestamp >= datetime('now', ? || ' days')
      GROUP BY ${project}
      ORDER BY costUsd DESC
    `.trim()
  }

  /** Potrošnja jednog zadatka — odgovor na "koliko je TASK-#### stajao". */
  getTaskUsage(taskId: string): { taskId: string; spawns: number; turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheHitRatio: number | null; costUsd: number } {
    const row = this.db.prepare(`
      SELECT COUNT(*)                               AS spawns,
             COALESCE(SUM(c.turns), 0)              AS turns,
             COALESCE(SUM(c.input_tokens), 0)       AS inputTokens,
             COALESCE(SUM(c.output_tokens), 0)      AS outputTokens,
             COALESCE(SUM(c.cache_read_tokens), 0)  AS cacheReadTokens,
             COALESCE(SUM(c.cache_write_tokens), 0) AS cacheWriteTokens,
             ${CACHE_HIT_RATIO_AGG}                 AS cacheHitRatio,
             COALESCE(SUM(c.cost_usd), 0)           AS costUsd
      FROM cost_log c WHERE c.task_id = ?
    `).get(taskId) as Omit<ReturnType<CostTracker['getTaskUsage']>, 'taskId'>
    return { taskId, ...row }
  }

  private calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number = 0,
    cacheWriteTokens: number = 0,
  ): number {
    return estimateCostUsd(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens)
  }
}

// ============================================
// Tarifna procjena (SSOT — dijele je CostTracker i SpawnTelemetry)
// ============================================

export function normalizeModel(model: string): string {
  const lower = (model || '').toLowerCase()

  // `fable`/`mythos` prije opusa: dijele obitelj, ali ne i cijenu (2× opus).
  if (lower.includes('fable') || lower.includes('mythos')) return 'fable'
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  if (lower.includes('gpt-4o')) return 'gpt-4o'
  if (lower.includes('gemini-2.5-pro') || lower.includes('gemini2.5pro')) return 'gemini-2.5-pro'

  // Local / Ollama / unknown = free
  return model
}

/**
 * Procjena cijene po tarifi. Koristi se SAMO kad CLI ne javi `total_cost_usd`
 * (v. napomenu o 1-satnom cacheu u zaglavlju datoteke).
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
): number {
  const rate = COST_RATES[normalizeModel(model)] || ZERO_RATE
  const usd =
    (inputTokens / 1_000_000) * rate.input +
    (outputTokens / 1_000_000) * rate.output +
    (cacheReadTokens / 1_000_000) * rate.cacheRead +
    (cacheWriteTokens / 1_000_000) * rate.cacheWrite

  return Math.round(usd * 1e8) / 1e8  // avoid floating point drift
}

// ============================================
// Procjena potrošnje struje (ADR-0010, TASK-4820)
// ============================================

/**
 * PROCJENA, NE MJERENJE. Potrošnju Claude modela dobavljač ne objavljuje; ovo je izvedena
 * vrijednost iz tokena koje `cost_log` već ima (ADR-0010 §3–§4), s rasponom ÷3…×3 (§4.5).
 * Svaki potrošač je DUŽAN prikazati je kao procjenu (znak `≈`, vlastita boja, riječ
 * „procjena", tooltip s metodom) — v. ADR §8.2.
 *
 * Tri stvari koje je istraga (TASK-4818/4819) pokazala, a koje se iz koda ne vide:
 *  1. Formula ima ČETIRI člana. Naivna `(ulaz + izlaz) × faktor` nad našim podatcima vidi
 *     13,7 % energije — 96 % našeg prometa je keš-čitanje (ADR M3, M9).
 *  2. `ENERGY_RATES ÷ COST_RATES = 130` u svakom članu, jer su omjeri koeficijenata preuzeti
 *     iz istog cjenika. Energija je zato PRETVORBA JEDINICE troška (130 Wh/USD), a ne novo
 *     mjerilo (ADR §11.1). Tko od nje očekuje nov uvid, dobit će prekrštenu brojku troška.
 *  3. Vrijednost se NE sprema u stupac (ADR §7): koeficijenti će se mijenjati čim iziđe bolji
 *     izvor, a upisana brojka bi zamrznula procjenu iz 2026. u retke zauvijek.
 */
/**
 * Koeficijenti se mogu nadjačati u `config/energija.json` (ili `TM_ENERGIJA_CONFIG`) — v.
 * `config/energija.example.json` s izvorima. Čita se JEDNOM pri učitavanju modula; nepoznat
 * ili nebrojčan ključ se preskače, pa tipfeler vraća zadanu vrijednost, a ne nulu.
 */
function koeficijenti(): Record<string, any> {
  try {
    const p = konfigPutanja('energija.json', 'TM_ENERGIJA_CONFIG')
    if (!existsSync(p)) return {}
    const raw = JSON.parse(readFileSync(p, 'utf-8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}
const KOEF = koeficijenti()
const broj = (v: unknown, zadano: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : zadano

export const ENERGY_RATES = {
  input: broj(KOEF.whPoMTok?.input, 390),
  output: broj(KOEF.whPoMTok?.output, 1950),
  cacheRead: broj(KOEF.whPoMTok?.cacheRead, 39),
  cacheWrite: broj(KOEF.whPoMTok?.cacheWrite, 490),
} as const  // Wh/MTok, razred „sonnet"
export const ENERGY_BAND = broj(KOEF.energijaPojas, 3)   // prikazani raspon ÷3…×3 (ADR §4.5)
export const ENERGY_METHOD = KOEF.whPoMTok ? 'konfiguracija' : 'A-couch-epoch-2026'  // Couch/Epoch (ADR §4.2)

/**
 * Množitelj razreda modela. Veličina Claude modela je poslovna tajna; jedini javni signal
 * koji je specifičan za model i monotono vezan uz trošak posluživanja jest cjenik, pa se
 * uzima omjer cijene ULAZA prema sonnetu (ADR §4.3). Normalizacija imena ide kroz POSTOJEĆI
 * `normalizeModel()` — drugog popisa modela nema, inače bi se dva popisa razišla.
 */
const ENERGY_K: Record<string, number> = {
  fable:  10 / 3,
  opus:    5 / 3,
  sonnet:  1,
  haiku:   1 / 3,
}

/** `k` za model; nepoznat razred (lokalni/tuđi model) → 1, ali uz zastavicu u `procijeniEnergijuWh`. */
export function energijaKRazreda(model: string): number {
  return ENERGY_K[normalizeModel(model)] ?? 1
}

export interface EnergijaRedak {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /**
   * Koliko je STVARNIH redaka `cost_loga` (s tokenima) sažeto u ovaj redak. Postoji jer
   * `ENERGIJA_PO_PROJEKTU_SQL` vraća već zbrojen redak po (projekt × model), a nazivnik
   * „iz N izvođenja" mora ostati broj izvođenja, ne broj modela. Izostane li — jedan redak
   * je jedno izvođenje.
   */
  zapisaSTokenima?: number
}

/**
 * Energija jednog retka `cost_loga`, u Wh.
 *
 * Vraća `null` — NE 0 — kad redak nema nijedan token (696 legacy redaka `model='opus'` sa
 * svim nulama, ADR M1). Nula bi na kartici izgledala kao izmjerena nula; nemjereno je crtica
 * (pravilo `TaskWebUI.ts:837`).
 */
export function procijeniEnergijuWh(r: EnergijaRedak): { wh: number; modelNepoznat: boolean } | null {
  const ulaz = Number(r.inputTokens) || 0
  const izlaz = Number(r.outputTokens) || 0
  const kc = Number(r.cacheReadTokens) || 0
  const kp = Number(r.cacheWriteTokens) || 0
  if (ulaz + izlaz + kc + kp <= 0) return null

  const razred = normalizeModel(r.model || '')
  const k = ENERGY_K[razred] ?? 1
  const wh = k * (
    (ulaz / 1_000_000) * ENERGY_RATES.input +
    (izlaz / 1_000_000) * ENERGY_RATES.output +
    (kc / 1_000_000) * ENERGY_RATES.cacheRead +
    (kp / 1_000_000) * ENERGY_RATES.cacheWrite
  )
  return { wh, modelNepoznat: !(razred in ENERGY_K) }
}

// --------------------------------------------
// CO₂ i voda (ADR-0011, TASK-4822)
// --------------------------------------------

/**
 * PROCJENA PRETVORBE PROCJENE. Obje su brojke JEDAN množitelj nad već izračunatim `wh` —
 * nema druge formule iz tokena. Ako je energija po ADR-0010 §11.1 pretvorba jedinice troška
 * (130 Wh/USD, identitet a ne korelacija), onda CO₂ i voda ne nose NIJEDAN bit koji € već
 * nema. Prikazuju se jer 122 kg i 640 L ljudima znače nešto što 5069 USD ne znači — i samo
 * uz označavanje iz ADR-0011 §4.
 *
 * Faktor mreže: 0,21 kg CO₂e/kWh = intenzitet proizvodnje struje EU-27 (EEA). LOKACIJSKI je,
 * i to je ograda koja MORA ići u sučelje: naši se modeli ne vrte na EU mreži nego u SAD-u,
 * gdje je ~0,37 (eGRID), dakle do 1,8× više. Odabran je zbog kontinuiteta s ADR-0010 M16
 * („122 kg CO₂e"), i jer svi kandidati (HR 0,19 · AWS 0,287 · SAD 0,37 · svijet 0,445)
 * leže unutar pojasa ÷4…×4. Promjena = jedna konstanta, cijela se povijest preračuna (§7).
 */
export const CO2_FACTOR_KG_PER_KWH = broj(KOEF.co2KgPoKWh, 0.21)
export const CO2_BAND = 4                       // ÷4…×4: energija ÷3…×3 + izbor mreže (ADR-0011 §2.3)
export const CO2_METHOD = KOEF.co2KgPoKWh ? 'konfiguracija' : 'EEA-EU27-2023'

/**
 * WUE — voda po kWh. `1,1` je usidren na JEDINO produkcijsko mjerenje na AI opterećenju:
 * Google, arXiv 2508.15734, 0,26 mL po medijanskom upitu ÷ 0,24 Wh = 1,08 L/kWh (isti par
 * koji ADR-0010 §3 već citira za energiju).
 *
 * Pojas je namjerno mnogo širi I NESIMETRIČAN, jer voda ima nesigurnost koju struja i CO₂
 * nemaju — granica obračuna nije dogovorena:
 *  - ÷10 dolje: objavljene flotne WUE idu do 0,12 L/kWh (AWS 2025., zatvoreni krug);
 *  - ×6 gore: „WUE" u izvješćima znači SAMO lice mjesta, a proizvodnja te iste struje troši
 *    još 3,1 (prosjek SAD) do 5,3 L/kWh (Siddik/Shehabi/Marston, ERL 2021) — to nije
 *    pesimizam nego ista voda koju samo nitko ne pripisuje podatkovnom centru.
 * Raspon objavljenih vrijednosti je time ~50×, prema ~4× za mrežni CO₂ → zato voda nosi
 * `grubaProcjena` i jače označavanje u sučelju (ADR-0011 §3.4, §4).
 */
export const VODA_WUE_L_PER_KWH = broj(KOEF.vodaLPoKWh, 1.1)
export const VODA_BAND_DOLJE = 10
export const VODA_BAND_GORE = 6
export const VODA_METHOD = KOEF.vodaLPoKWh ? 'konfiguracija' : 'google-2508.15734-onsite'

export interface Co2Sazetak {
  kg: number
  donja: number
  gornja: number
  faktor: number        // kg CO₂e/kWh — putuje do klijenta da ondje NE stoji druga kopija
  metoda: string
  procjena: true
}

export interface VodaSazetak {
  l: number
  donja: number
  gornja: number
  wue: number           // L/kWh — isto, jedan izvor istine
  metoda: string
  procjena: true
  grubaProcjena: true   // UGOVOR prema sučelju: traži jače označavanje od `procjena` (ADR-0011 §4)
}

const zaokr = (x: number) => Math.round(x * 1e4) / 1e4

export function procijeniCo2Kg(wh: number): number { return (Number(wh) || 0) / 1000 * CO2_FACTOR_KG_PER_KWH }
export function procijeniVoduL(wh: number): number { return (Number(wh) || 0) / 1000 * VODA_WUE_L_PER_KWH }

/** `null` — ne 0 — kad energije nema; nemjereno je crtica (isto pravilo kao energija). */
export function sazmiCo2(wh: number): Co2Sazetak | null {
  if (!(Number(wh) > 0)) return null
  const kg = procijeniCo2Kg(wh)
  return { kg: zaokr(kg), donja: zaokr(kg / CO2_BAND), gornja: zaokr(kg * CO2_BAND),
           faktor: CO2_FACTOR_KG_PER_KWH, metoda: CO2_METHOD, procjena: true }
}

/** `null` — ne 0 — kad energije nema. */
export function sazmiVodu(wh: number): VodaSazetak | null {
  if (!(Number(wh) > 0)) return null
  const l = procijeniVoduL(wh)
  return { l: zaokr(l), donja: zaokr(l / VODA_BAND_DOLJE), gornja: zaokr(l * VODA_BAND_GORE),
           wue: VODA_WUE_L_PER_KWH, metoda: VODA_METHOD, procjena: true, grubaProcjena: true }
}

export interface EnergijaSazetak {
  wh: number            // središnja procjena (Wh)
  donja: number         // wh / ENERGY_BAND
  gornja: number        // wh * ENERGY_BAND
  metoda: string
  procjena: true        // OBVEZNO polje, ne komentar — sučelje se na njega oslanja (ADR §7)
  izTokena: number      // iz koliko je redaka s tokenima izračunata (nazivnik)
  modelNepoznat: number // koliko redaka nije prepoznatog razreda
  co2: Co2Sazetak | null   // ADR-0011: izvedeno iz `wh`, ne iz tokena iznova
  voda: VodaSazetak | null
}

/**
 * Sažetak iz već zbrojenih Wh. Postoji da bi ga dijelili `sazmiEnergiju` (po projektu) i
 * ukupna brojka u `/api/projects/trosak` — dvije ruke koje neovisno slažu isti objekt su
 * isti raskorak koji je TASK-4263 već jednom otkrio kod troška.
 */
export function energijaSazetakOdWh(wh: number, izTokena: number, modelNepoznat: number): EnergijaSazetak | null {
  if (!izTokena) return null
  return {
    wh: zaokr(wh),
    donja: zaokr(wh / ENERGY_BAND),
    gornja: zaokr(wh * ENERGY_BAND),
    metoda: ENERGY_METHOD,
    procjena: true,
    izTokena,
    modelNepoznat,
    co2: sazmiCo2(wh),
    voda: sazmiVodu(wh),
  }
}

/**
 * Zbroj energije preko redaka (npr. jedan projekt, grupiran po modelu).
 * `null` kad nijedan redak nema tokene — kartica tada pokazuje „—", ne „0 kWh".
 */
export function sazmiEnergiju(redci: EnergijaRedak[]): EnergijaSazetak | null {
  let wh = 0, izTokena = 0, modelNepoznat = 0
  for (const r of redci) {
    const e = procijeniEnergijuWh(r)
    if (!e) continue
    const n = Math.max(1, Number(r.zapisaSTokenima ?? 1) || 1)
    wh += e.wh
    izTokena += n
    if (e.modelNepoznat) modelNepoznat += n
  }
  return energijaSazetakOdWh(wh, izTokena, modelNepoznat)
}

// ============================================
// Singleton
// ============================================

let _instance: CostTracker | null = null

export function getCostTracker(dbPath?: string): CostTracker {
  if (!_instance || dbPath) {
    _instance = new CostTracker(dbPath)
  }
  return _instance
}

// ============================================
// Ukupna potrošnja po projektu (ploča: GET /api/projects/trosak)
// ============================================

/**
 * PROJEKT SE ČITA JOIN-om NA ZADATAK. `logUsage` namjerno upisuje `project_id = NULL` kad
 * redak ima `task_id` — zadatak je izvor istine, jer se njegov projekt može ispraviti
 * naknadno, a zamrznuta vrijednost u `cost_log` bi tada lagala. Tko grupira samo po
 * `cost_log.project_id`, dobije da SVAKI spawn vezan uz zadatak nema projekt.
 *
 * Upravo se to i događalo na ploči do 05.09.2026. (TASK-4263): mjereno 91,32 USD u
 * 23 zapisa u 24 h u pretincu „(bez projekta)", a svih 23 imaju zadatak koji IMA projekt.
 * Na kartici projekta vidio se samo trošak iz retroaktivnog uvoza (on je `project_id`
 * upisivao izravno, bez zadatka), a nijedan sat živog rada.
 *
 * SQL stoji OVDJE, uz `logUsage` čiji ugovor provodi, a ne uz endpoint: dva mjesta koja
 * neovisno odlučuju kako se čita projekt su isti raskorak koji je i nastao.
 *
 * `$1` (kad se koristi) je granica prozora za `datetime('now', ?)`, npr. `-30 days`.
 */
export const TROSAK_PO_PROJEKTU_SQL = `
      SELECT COALESCE(t.project_id, c.project_id, '(bez projekta)') AS pid,
             ROUND(SUM(c.cost_usd), 4) AS usd,
             COUNT(*)                  AS zapisa,
             MAX(c.timestamp)          AS zadnji
        FROM cost_log c
        LEFT JOIN tasks t ON t.id = c.task_id
       GROUP BY pid`

/**
 * Energija po projektu (ADR-0010 §7, §11.3) — ISTI pripis projekta kao trošak, ali
 * **`GROUP BY pid, c.model`**.
 *
 * Zašto model mora biti u ključu: množitelj razreda `k` (§4.3) razlikuje opus od sonneta
 * 1,67×, a `claude-opus-5` je 80 % našeg prometa. Tko doda `SUM(input_tokens)` postojećem
 * `TROSAK_PO_PROJEKTU_SQL` i ostane na `GROUP BY pid`, primijeni `k = 1` na sve retke i
 * **podcijeni energiju 1,584× (manjka 36,9 %)** — mjereno 12.09.2026. nad cijelim `cost_logom`.
 *
 * Postojeći upit troška se namjerno NE dira: trošak i energija ostaju dva upita s istim
 * pripisom projekta, a ne jedan upit s dvije svrhe.
 */
export const ENERGIJA_PO_PROJEKTU_SQL = `
      SELECT COALESCE(t.project_id, c.project_id, '(bez projekta)') AS pid,
             c.model                          AS model,
             SUM(c.input_tokens)              AS input_tokens,
             SUM(c.output_tokens)             AS output_tokens,
             SUM(c.cache_read_tokens)         AS cache_read_tokens,
             SUM(c.cache_write_tokens)        AS cache_write_tokens,
             COUNT(*)                         AS zapisa,
             SUM(CASE WHEN COALESCE(c.input_tokens,0) + COALESCE(c.output_tokens,0)
                         + COALESCE(c.cache_read_tokens,0) + COALESCE(c.cache_write_tokens,0) > 0
                      THEN 1 ELSE 0 END)      AS zapisa_s_tokenima
        FROM cost_log c
        LEFT JOIN tasks t ON t.id = c.task_id
       GROUP BY pid, c.model`

/** Isti agregat, ograničen na prozor (parametar: npr. `-30 days`). */
export const TROSAK_PO_PROJEKTU_PROZOR_SQL = `
      SELECT COALESCE(t.project_id, c.project_id, '(bez projekta)') AS pid,
             ROUND(SUM(c.cost_usd), 4) AS usd,
             COUNT(*)                  AS zapisa
        FROM cost_log c
        LEFT JOIN tasks t ON t.id = c.task_id
       WHERE c.timestamp > datetime('now', ?)
       GROUP BY pid`
