/**
 * TkoVodi — tko na ovom stroju stvarno vodi zadatke (TASK-5368, nalaz TASK-5360).
 *
 * Kartica Orkestrator je čitala samo registar paketa (config/agents.json) i na čvoru s
 * RegocDaemonom pisala „Agenata u registru: 0 — orkestrator ne pokreće ništa", iako daemon
 * sustava domaćina (TM_AGENTS_REGISTRY) vodi zadatke s 12 agenata. Odluka je ovdje, bez I/O, da se rubni
 * slučajevi testiraju bez pravog daemona; živost daje DaemonLiveness (PID + cmdline).
 *
 * Autorica: Jelena (Engineer), TASK-5368.
 */

export type Vodja = 'regocdaemon' | 'paket' | 'nitko'

export interface TkoVodiUlaz {
  /** Rezultat DaemonLiveness: živ proces s `RegocDaemon.ts` u cmdline. */
  daemon: { alive: boolean; pid: number | null }
  /** Agenata u registru sustava (TM_AGENTS_REGISTRY / REGOC_AGENTS.json). */
  agenataSustava: number
  /** Agenata u registru orkestratora paketa (config/agents.json). */
  agenataPaketa: number
  /** `enabled` iz orchestrator.json. */
  paketUkljucen: boolean
}

export interface TkoVodi {
  vodi: Vodja
  /** Agenti onoga tko vodi — to je broj koji kartica smije pokazati kao „u radu". */
  agenata: number
  pid: number | null
}

export function tkoVodiZadatke(u: TkoVodiUlaz): TkoVodi {
  if (u.daemon.alive) return { vodi: 'regocdaemon', agenata: u.agenataSustava, pid: u.daemon.pid }
  if (u.paketUkljucen) return { vodi: 'paket', agenata: u.agenataPaketa, pid: null }
  return { vodi: 'nitko', agenata: 0, pid: null }
}
