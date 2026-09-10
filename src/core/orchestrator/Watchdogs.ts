/**
 * Watchdogs — čistači zaglavljenog posla (ADR-0001 §3.4).
 *
 * Tri kvara koja se u pogonu doista događaju:
 *   zombi   — zadatak je `in_progress`, a proces koji ga je uzeo više ne postoji;
 *   stale   — proces postoji, ali mjera napretka stoji dulje od prozora;
 *   strop   — spawn traje dulje od tvrdog stropa, bez obzira na sve.
 *
 * TRI PRAVILA IZ ISKUSTVA, UGRAĐENA OVDJE:
 *
 * 1. `off → shadow → live`, kao svaki mehanizam u ovom sustavu. U sjeni se sud ZAPISUJE, a
 *    ne izvršava — jer čistač koji pogriješi ubija tuđi rad, a to se vidi tek poslije.
 * 2. Strop poteza po prolazu (`maxActionsPerRun`). Bez njega prva ispravna primjena na
 *    starom sustavu dira stotine zadataka odjednom.
 * 3. MILOST NAKON RESTARTA: nakon ponovnog pokretanja jezgra ne zna za spawnove koje je
 *    dizala prethodna generacija, pa svaki živ agent izgleda kao zombi. Zato zadatak koji
 *    nije u tablici aktivnih ne pada odmah, nego tek kad ni port života ne potvrdi PID —
 *    a bez PID-a se čeka `milostMs` od pokretanja jezgre.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import type { AktivniSpawn, SpawnQueue } from './SpawnQueue'
import type { Board, LivenessProbe, Logger, Task } from './Ports'
import type { WatchdogMode } from './OrchestratorConfig'

export type VrstaNalaza = 'zombi' | 'stale' | 'strop'

export interface Nalaz {
  vrsta: VrstaNalaza
  taskId: string
  agentId?: string
  pid?: number
  razlog: string
  /** Je li potez doista izvršen (`live`) ili samo zapisan (`shadow`). */
  izvrseno: boolean
}

export interface WatchdogOpcije {
  mode: WatchdogMode
  maxActionsPerRun: number
}

export interface WatchdogsOpcije {
  stale: WatchdogOpcije
  zombie: WatchdogOpcije
  deadAgent: WatchdogOpcije
  livenessWindowHours: number
  /** Koliko se čeka prije nego se zadatak bez poznatog PID-a proglasi zombijem. */
  milostMs?: number
  now?: () => number
}

export class Watchdogs {
  private opcije: WatchdogsOpcije
  private board: Board
  private queue: SpawnQueue
  private liveness: LivenessProbe
  private logger: Logger
  private pokrenutU: number
  /** Zadnja viđena mjera napretka po PID-u — bez povijesti se „stoji" ne može utvrditi. */
  private napredak = new Map<number, { vrijednost: number; ts: number }>()

  constructor(
    board: Board, queue: SpawnQueue, liveness: LivenessProbe, logger: Logger,
    opcije: WatchdogsOpcije,
  ) {
    this.board = board
    this.queue = queue
    this.liveness = liveness
    this.logger = logger
    this.opcije = opcije
    this.pokrenutU = this.now()
  }

  private now(): number { return (this.opcije.now || Date.now)() }

  /** Jedan prolaz. Vraća sve nalaze — i one koje je u sjeni samo zapisao. */
  async prolaz(): Promise<Nalaz[]> {
    const nalazi: Nalaz[] = []
    const uRadu = await this.board.list('in_progress')
    const aktivni = new Map(this.queue.aktivniPopis().map(s => [s.taskId, s]))
    const milost = this.opcije.milostMs ?? 5 * 60_000

    let zombiPoteza = 0
    let stalePoteza = 0

    for (const t of uRadu) {
      const spawn = aktivni.get(t.id)

      if (!spawn) {
        // Nema ga u tablici: ili je pao, ili ga je dizala prethodna generacija (milost).
        if (this.now() - this.pokrenutU < milost) continue
        if (zombiPoteza >= this.opcije.zombie.maxActionsPerRun) continue
        zombiPoteza++
        nalazi.push(await this.rijesi('zombi', this.opcije.zombie, t,
          'zadatak je in_progress, a jezgra nema živ spawn za njega'))
        continue
      }

      if (spawn.pid && !this.liveness.alive(spawn.pid)) {
        if (zombiPoteza >= this.opcije.zombie.maxActionsPerRun) continue
        zombiPoteza++
        this.queue.oslobodi(t.id, false)
        nalazi.push(await this.rijesi('zombi', this.opcije.zombie, t,
          `proces ${spawn.pid} više ne postoji`, spawn))
        continue
      }

      if (this.prekoStropa(spawn)) {
        if (stalePoteza >= this.opcije.stale.maxActionsPerRun) continue
        stalePoteza++
        nalazi.push(await this.rijesi('strop', this.opcije.stale, t,
          `spawn traje dulje od tvrdog stropa`, spawn))
        continue
      }

      if (spawn.pid && this.stoji(spawn.pid)) {
        if (stalePoteza >= this.opcije.stale.maxActionsPerRun) continue
        stalePoteza++
        nalazi.push(await this.rijesi('stale', this.opcije.stale, t,
          `mjera napretka procesa ${spawn.pid} stoji dulje od ` +
          `${this.opcije.livenessWindowHours} h`, spawn))
      }
    }
    return nalazi
  }

  private prekoStropa(spawn: AktivniSpawn): boolean {
    return this.queue.prekoStropa().some(s => s.taskId === spawn.taskId)
  }

  /** Stoji li proces? Prvi susret s PID-om nikad nije „stoji" — nema s čime usporediti. */
  private stoji(pid: number): boolean {
    const sada = this.liveness.progress(pid)
    if (sada === null) return false
    const prije = this.napredak.get(pid)
    if (!prije || prije.vrijednost !== sada) {
      this.napredak.set(pid, { vrijednost: sada, ts: this.now() })
      return false
    }
    return this.now() - prije.ts > this.opcije.livenessWindowHours * 3600_000
  }

  private async rijesi(
    vrsta: VrstaNalaza, opcije: WatchdogOpcije, task: Task, razlog: string, spawn?: AktivniSpawn,
  ): Promise<Nalaz> {
    const nalaz: Nalaz = {
      vrsta, taskId: task.id, agentId: spawn?.agentId || task.assignee || undefined,
      pid: spawn?.pid, razlog, izvrseno: false,
    }
    if (opcije.mode === 'off') return nalaz
    if (opcije.mode === 'live') {
      // `in_progress → pending` ide ISKLJUČIVO kroz reclaim: izravan PUT taj prijelaz
      // odbija s 409, pa bi zadatak ostao zaglavljen uz lažan zapis da je vraćen.
      nalaz.izvrseno = await this.board.reclaim(task.id, `${vrsta}: ${razlog}`, 'orchestrator')
      if (nalaz.izvrseno) this.queue.oslobodi(task.id, false)
    }
    this.logger.log(
      `[watchdog:${vrsta}] ${task.id} — ${razlog} ` +
      `(${opcije.mode}${nalaz.izvrseno ? ', vraćen u red' : ''})`,
    )
    return nalaz
  }
}
