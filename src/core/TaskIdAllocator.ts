#!/usr/bin/env bun
/**
 * TaskIdAllocator - JEDINI IZVOR ISTINE (SSOT) za dodjelu TASK-NNN ID-eva
 *
 * Prije ovog modula postojala su DVA neovisna allocatora nad istim ID prostorom:
 *   1) TaskManagerSQL.calculateNextId() - MAX(id) iz SQLite tasks tablice
 *   2) TaskManager.initializeNextId()   - MAX(id) iz markdown storea (~/.claude/tasks/agents/*.md)
 * MD store zaostaje za bazom (max TASK-336 vs TASK-2703), pa je svaki task kreiran
 * MD putanjom dobivao 3xx ID koji je vec postojao u bazi i tiho prepisivao tudi task
 * preko ON CONFLICT DO UPDATE. (TASK-2702)
 *
 * Rjesenje: perzistentni brojac u tablici `task_id_seq` unutar iste SQLite baze.
 *   - brojac se NIKAD ne smanjuje  -> ID obrisanog taska se ne recikliraju
 *   - floor = high-water-mark iz `tasks` I `task_history` -> siguran i na staroj bazi
 *   - alokacija ide u IMMEDIATE transakciji -> atomicno i izmedu procesa
 *
 * Author: Jelena Kovacevic (Engineer Agent)
 * Version: 1.0.0
 * Date: 2026-07-28
 */

import type { Database } from "bun:sqlite";

// ============================================
// ID FORMAT
// ============================================

export const TASK_ID_PREFIX = 'TASK-';

/** Zero-padded na 3 znamenke radi kompatibilnosti s postojecim TASK-001..TASK-999 */
export function formatTaskId(num: number): string {
  return `${TASK_ID_PREFIX}${String(num).padStart(3, '0')}`;
}

/** 'TASK-2703' -> 2703 ; sve ostalo -> null */
export function parseTaskId(id: string): number | null {
  const match = /^TASK-(\d+)$/.exec(id);
  return match ? parseInt(match[1], 10) : null;
}

// ============================================
// ALLOCATOR
// ============================================

const SEQ_KEY = 'task';
const SEQ_TABLE = 'task_id_seq';

/** Tablice koje drze povijest koristenih ID-eva (ukljucujuci obrisane taskove) */
const HIGH_WATER_SOURCES: Array<{ table: string; column: string }> = [
  { table: 'tasks', column: 'id' },
  { table: 'task_history', column: 'task_id' },
];

export class TaskIdAllocator {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.ensureSchema();
  }

  /**
   * Kreira counter tablicu ako ne postoji i sjeme ju na trenutni high-water-mark.
   * Idempotentno - sigurno za pozivanje na svakom startupu.
   */
  private ensureSchema(): void {
    // Read-only fast path: konstruktor se zove na svakom startupu i iz vise procesa,
    // pa ne uzimamo write lock kad nema sto za napraviti.
    if (this.tableExists(SEQ_TABLE) && this.readCounter() > 0) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${SEQ_TABLE} (
        key        TEXT PRIMARY KEY,
        next_id    INTEGER NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.db.run(
      `INSERT OR IGNORE INTO ${SEQ_TABLE} (key, next_id) VALUES (?, ?)`,
      [SEQ_KEY, this.highWaterMark() + 1]
    );
  }

  private tableExists(table: string): boolean {
    const row = this.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) as { name: string } | null;
    return row !== null && row !== undefined;
  }

  /**
   * Najveci ikad koristen broj - iz zivih taskova I iz audit traila.
   * Audit trail je bitan: TASK-321/322/323 su obrisani 2026-07-21 pa ponovno
   * dodijeljeni 2026-07-27; bez task_history-a bi se recikliranje nastavilo.
   */
  private highWaterMark(): number {
    let max = 0;
    for (const { table, column } of HIGH_WATER_SOURCES) {
      if (!this.tableExists(table)) continue;
      const row = this.db
        .query(
          `SELECT MAX(CAST(SUBSTR(${column}, ${TASK_ID_PREFIX.length + 1}) AS INTEGER)) AS max_num
           FROM ${table} WHERE ${column} LIKE '${TASK_ID_PREFIX}%'`
        )
        .get() as { max_num: number | null } | null;
      const num = row?.max_num ?? 0;
      if (num > max) max = num;
    }
    return max;
  }

  private readCounter(): number {
    const row = this.db
      .query(`SELECT next_id FROM ${SEQ_TABLE} WHERE key = ?`)
      .get(SEQ_KEY) as { next_id: number } | null;
    return row?.next_id ?? 0;
  }

  /** Broj koji bi sljedeca alokacija vratila (bez mutiranja brojaca). */
  peekNumber(): number {
    return Math.max(this.readCounter(), this.highWaterMark() + 1);
  }

  /** ID koji bi sljedeca alokacija vratila (bez mutiranja brojaca). */
  peek(): string {
    return formatTaskId(this.peekNumber());
  }

  /**
   * Atomicno rezervira sljedeci broj. Brojac se podize na max(perzistirani, HWM+1)
   * prije citanja, pa je rezultat uvijek strogo veci od svakog postojeceg ID-a.
   */
  allocateNumber(): number {
    const tx = this.db.transaction(() => {
      const next = Math.max(this.readCounter(), this.highWaterMark() + 1);
      this.db.run(
        `UPDATE ${SEQ_TABLE} SET next_id = ?, updated_at = datetime('now') WHERE key = ?`,
        [next + 1, SEQ_KEY]
      );
      return next;
    });
    // IMMEDIATE uzima write lock odmah -> dva procesa ne mogu procitati isti next_id
    return typeof (tx as any).immediate === 'function' ? (tx as any).immediate() : tx();
  }

  /** Atomicno rezervira sljedeci ID u 'TASK-NNN' formatu. */
  allocate(): string {
    return formatTaskId(this.allocateNumber());
  }
}

export default TaskIdAllocator;
