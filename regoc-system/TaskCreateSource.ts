// ─── TaskCreateSource ────────────────────────────────────────────────────────
// M2 dorada / TASK-4646 (PRJ REGOC_SYSTEM): TKO je stvorio zadatak.
//
// NALAZ: `handleCreateTask` (TaskWebUI) od TASK-4628 poštuje polje `createdBy`, ali ga
// nitko od strojnih pošiljatelja nije slao — RegocDaemon (delegacija, lanac dorade) i
// `tools/decompose.ts` (razlaganje) POST-ali su bez njega, pa su svi ti zadatci padali u
// zadani izvor `user`. Mjereno nad živom `data/regoc.db` 04.09.2026.: SVI zadatci imaju
// `created_by='user'`, uključujući one koje čovjek nikad nije ni vidio.
//
// ZAŠTO JE TO KVAR, a ne kozmetika:
//   1. Strop stvaranja zadataka (TaskCreateBreaker, 30/h PO IZVORU) mjeri po `createdBy`.
//      Dok daemon i čovjek dijele isti izvor, rafal daemona troši kvotu čovjeku i obratno:
//      čovjek ostane bez ploče zbog tuđeg rafala, a daemonov rafal se skrije iza čovjeka.
//   2. Dojava o rafalu imenuje IZVOR. `user` ne kaže ništa — epizoda se ne može pripisati
//      ni popraviti na uzroku.
//   3. Autonomija čita `created_by='user'` kao trag da ČOVJEK radi (RegocDaemon
//      `readHumanIdleMs`). Dok daemon piše `user`, sustav vlastitu buku čita kao ljudsku
//      aktivnost — točno ono što komentar te funkcije izrijekom zabranjuje.
//
// IMENA IZVORA (kratka, stabilna, bez razmaka — ulaze u SQL GROUP BY i u dojavu):
//   `regoc`        — RegocDaemon, zadatak uz delegaciju agentu,
//   `regoc-chain`  — RegocDaemon, koraci multi-agent lanca (R2 helper / T1 tim),
//   `decomposer`   — `tools/decompose.ts`, podzadatci iz razlaganja plana,
//   `user`         — čovjek (web forma, Telegram, ručni curl). Zadano na ingressu.
//
// Svaki strojni put dobiva SVOJU kvotu: to je namjerno. Lanac dorade i razlaganje su dva
// različita kvara kad podivljaju i moraju se moći odvojeno izmjeriti i zaustaviti.
//
// Autorica: Jelena (Engineer) · 2026-09-04 · TASK-4646 · uz ADR-0007 (M2)

/** Kanonska imena izvora za `createdBy` na POST /api/tasks. */
export const TASK_SOURCE = {
  /** RegocDaemon — zadatak stvoren uz delegaciju agentu. */
  DAEMON: 'regoc',
  /** RegocDaemon — koraci multi-agent lanca (R2 helper / T1 tim). */
  CHAIN: 'regoc-chain',
  /** `tools/decompose.ts` — podzadatci iz razloženog plana (P5c). */
  DECOMPOSER: 'decomposer',
  /** Čovjek. Zadano na ingressu kad polje nije poslano. */
  HUMAN: 'user',
} as const

export type TaskSource = (typeof TASK_SOURCE)[keyof typeof TASK_SOURCE]

/** Isti strop kao na ingressu (`handleCreateTask` reže na 64 znaka). */
export const MAX_SOURCE_LEN = 64

/** Izvori koje stvara stroj — sve osim čovjeka. */
export const MACHINE_TASK_SOURCES: string[] = [
  TASK_SOURCE.DAEMON,
  TASK_SOURCE.CHAIN,
  TASK_SOURCE.DECOMPOSER,
]

/** Je li zadatak stvorio stroj (za izvještaje i trijažu rafala). */
export function isMachineSource(source?: string | null): boolean {
  return !!source && MACHINE_TASK_SOURCES.includes(source)
}

/**
 * Dopiši izvor tijelu POST-a.
 *
 * Već upisan `createdBy` se NE pregazi (pozivatelj zna bolje od zadane vrijednosti), a
 * prazan/nevaljan izvor pada na `regoc`, nikad na `user`: tiho vraćanje u `user` je upravo
 * kvar koji se ovdje popravlja.
 */
export function withCreatedBy<T extends Record<string, unknown>>(
  body: T,
  source: string,
): T & { createdBy: string } {
  const vlastiti = typeof body.createdBy === 'string' ? body.createdBy.trim() : ''
  const izvor = (vlastiti || (typeof source === 'string' ? source.trim() : '') || TASK_SOURCE.DAEMON)
    .slice(0, MAX_SOURCE_LEN)
  return { ...body, createdBy: izvor }
}
