/**
 * Orchestrator — jezgra: poruke → odluka → spawn → ishod (ADR-0001 O2).
 *
 * Ovo je sloj 1 iz `docs/SUSTAV.md`, koji je dosad postojao samo kao opis. Sve nuspojave
 * idu kroz portove (`Ports.ts`), pa se cijela petlja vrti u testu s izvedbama u memoriji.
 *
 * ŠTO OVDJE NAMJERNO NE POSTOJI (jer pripada domaćinu, ADR-0001 O3):
 *   • nijedno ime agenta — registar je konfiguracija (`AgentRegistry`);
 *   • nijedna ključna riječ rutiranja — i one su konfiguracija;
 *   • nijedna adresa i nijedna rečenica o infrastrukturi — `prompt.systemFacts`;
 *   • nijedan izravan pristup bazi — sve ide kroz `Board` (nalaz L5).
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import type { AgentInfo, ExecResult, Message, OrchestratorPorts, Task } from './Ports'
import { SpawnQueue } from './SpawnQueue'
import { Watchdogs, type Nalaz } from './Watchdogs'
import { orkestratorUkljucen, promptApiBase, type OrchestratorPostavke } from './OrchestratorConfig'

/** Okolina za dežurni potez: preusmjeren CLI ne smije nositi prijavu pretplate. */
function okolinaDezurnog(env: Record<string, string>): Record<string, string> {
  const o: Record<string, string> = { ...(process.env as Record<string, string>), ...env }
  delete o.CLAUDE_CODE_OAUTH_TOKEN
  return o
}

export interface IshodProlaza {
  poruka: { procitano: number; otvoreno: number; preskoceno: number }
  spawn: { pokrenuto: number; odbijeno: number }
  watchdog: Nalaz[]
  /** Zašto prolaz nije ništa napravio — prazno ako jest. Tiho stajanje je kvar. */
  napomene: string[]
}

export class Orchestrator {
  private p: OrchestratorPorts
  private cfg: OrchestratorPostavke
  private queue: SpawnQueue
  private watchdogs: Watchdogs
  private radi = false
  private tajmer: ReturnType<typeof setTimeout> | null = null
  private zadnjiAutoExec = 0

  /**
   * `opcije.maxConcurrent` — živi izvor stropa (postavka TaskManagera, Config stranica).
   * Bez njega vrijedi `cfg.spawn.maxConcurrent` (fiksno, npr. u testu).
   */
  constructor(ports: OrchestratorPorts, cfg: OrchestratorPostavke, opcije: { maxConcurrent?: () => number } = {}) {
    this.p = ports
    this.cfg = cfg
    this.queue = new SpawnQueue({
      maxConcurrent: opcije.maxConcurrent ?? cfg.spawn.maxConcurrent,
      backoff: cfg.spawn.backoff,
      hardCeilingHours: cfg.spawn.hardCeilingHours,
      now: () => ports.clock.now(),
    })
    this.watchdogs = new Watchdogs(ports.board, this.queue, ports.liveness, ports.logger, {
      stale: cfg.watchdog.stale,
      zombie: cfg.watchdog.zombie,
      deadAgent: cfg.watchdog.deadAgent,
      livenessWindowHours: cfg.spawn.livenessWindowHours,
      now: () => ports.clock.now(),
    })
  }

  stanje() {
    return {
      radi: this.radi,
      ukljucen: orkestratorUkljucen(this.cfg),
      spawn: this.queue.stanje(),
      agenata: this.p.agents.list().length,
      izvodac: this.p.executor.ime,
    }
  }

  /** Jedan prolaz petlje. Sve je u njemu — `start()` ga samo ponavlja. */
  async jedanProlaz(): Promise<IshodProlaza> {
    const ishod: IshodProlaza = {
      poruka: { procitano: 0, otvoreno: 0, preskoceno: 0 },
      spawn: { pokrenuto: 0, odbijeno: 0 },
      watchdog: [],
      napomene: [],
    }

    if (!orkestratorUkljucen(this.cfg)) {
      ishod.napomene.push('orkestrator je isključen (enabled: false)')
      return ishod
    }
    if (!this.p.agents.list().length) {
      ishod.napomene.push('registar agenata je prazan — nema koga pokrenuti (config/agents.json)')
    }

    await this.obradiPoruke(ishod)

    const sada = this.p.clock.now()
    if (sada - this.zadnjiAutoExec >= this.cfg.autoExecIntervalMs) {
      this.zadnjiAutoExec = sada
      await this.pokreniZadatke(ishod)
    }

    ishod.watchdog = await this.watchdogs.prolaz()
    return ishod
  }

  // ─── Poruke → zadaci ───────────────────────────────────────────────────────

  private async obradiPoruke(ishod: IshodProlaza): Promise<void> {
    const poruke = await this.p.bus.pending(10)
    for (const m of poruke) {
      ishod.poruka.procitano++
      // Preuzimanje PRIJE obrade: dvije petlje nad istim redom inače otvore dva zadatka
      // iz jedne poruke. Cijena je da se poruka u rijetkom padu izgubi — a to je manja
      // šteta od tihe duplikacije.
      if (!(await this.p.bus.claim(m.id))) { ishod.poruka.preskoceno++; continue }
      try {
        const otvoren = await this.porukaUZadatak(m)
        if (otvoren) ishod.poruka.otvoreno++
        else ishod.poruka.preskoceno++
      } catch (e: any) {
        this.p.logger.log(`[orchestrator] poruka ${m.id} nije obrađena: ${e?.message || e}`)
        ishod.poruka.preskoceno++
      } finally {
        await this.p.bus.complete(m.id)
      }
    }
  }

  private async porukaUZadatak(m: Message): Promise<boolean> {
    const tekst = String(m.content || '').trim()
    if (!tekst) return false
    const ruta = this.p.agents.route(tekst)
    if (!ruta) {
      this.p.logger.log(`[orchestrator] poruka ${m.id}: nijedan agent ne pokriva ovaj tekst`)
      return false
    }
    const naslov = tekst.split('\n')[0]!.slice(0, 120)
    const stvoren = await this.p.board.create({
      title: naslov,
      description: tekst,
      assignee: ruta.agentId,
    })
    if (!stvoren) return false
    this.p.logger.log(`[orchestrator] ${stvoren.id} ← poruka ${m.id} → ${ruta.agentId} (${ruta.razlog})`)
    return true
  }

  // ─── Zadaci → spawn ────────────────────────────────────────────────────────

  private async pokreniZadatke(ishod: IshodProlaza): Promise<void> {
    const cekaju = await this.p.board.list('pending')
    for (const t of cekaju) {
      const agent = this.odaberiAgenta(t)
      if (!agent) {
        this.p.logger.log(`[orchestrator] ${t.id}: nema agenta (assignee „${t.assignee || '—'}")`)
        continue
      }
      const dozvola = this.queue.smije(agent.id, t.id)
      if (!dozvola.ok) {
        ishod.spawn.odbijeno++
        this.p.logger.log(`[orchestrator] ${t.id} odgođen: ${dozvola.poruka}`)
        // Strop znači da nema smisla gledati ostale zadatke u ovom prolazu.
        if (dozvola.razlog === 'strop') break
        continue
      }
      ishod.spawn.pokrenuto++
      await this.pokreniZadatak(t, agent)
    }
  }

  private odaberiAgenta(t: Task): AgentInfo | null {
    if (t.assignee) return this.p.agents.get(t.assignee)
    const ruta = this.p.agents.route(`${t.title}\n${t.description || ''}`)
    return ruta ? this.p.agents.get(ruta.agentId) : null
  }

  /** Pokreni jedan zadatak i zapiši ishod na ploču. Iznimka ne smije oboriti petlju. */
  async pokreniZadatak(t: Task, agent: AgentInfo): Promise<ExecResult> {
    this.queue.zauzmi(agent.id, t.id)
    await this.p.board.update(t.id, { status: 'in_progress', assignee: agent.id })

    const prompt = this.p.prompt.build({
      task: t,
      agent,
      apiBaseUrl: promptApiBase(this.cfg),
      systemFacts: this.cfg.prompt.systemFacts || [],
    })

    const dz = this.p.dezurni?.ukljucen() ? this.p.dezurni : null
    const simulirano = !!dz?.simulacija()
    const pokreni = async (rez?: { model?: string; env: Record<string, string> }): Promise<ExecResult> => {
      try {
        return await this.p.executor.run({
          agentId: agent.id,
          model: rez ? rez.model : agent.model,
          prompt,
          taskId: t.id,
          ...(rez ? { extra: { env: okolinaDezurnog(rez.env) } } : {}),
        })
      } catch (e: any) {
        return { exitCode: 1, resultText: '', greska: String(e?.message || e) }
      }
    }

    let rezultat: ExecResult = simulirano
      ? { exitCode: 1, resultText: '', greska: 'simulirani pad primarnog modela (429 rate limit — simulacija s ploče)' }
      : await pokreni()

    // TASK-5359: primarni model pao (429/401/limit/nedostupan) → isti agent, isti prompt, na
    // dežurnom modelu kroz isti CLI (ANTHROPIC_BASE_URL). Alati agenta ostaju.
    let dezurniOpis: string | null = null
    const pad = dz && rezultat.exitCode !== 0 ? dz.jePad(`${rezultat.greska || ''}\n${rezultat.resultText || ''}`) : null
    if (dz && pad) {
      dz.greska()
      const rez = dz.cilj()
      const uzrok = `${simulirano ? 'SIMULIRAN pad' : pad.vrsta}: ${pad.razlog}`
      if (rez) {
        this.p.logger.log(`[orchestrator] ${t.id} (${agent.id}): primarni model pao (${uzrok}) — ponavljam na dežurnom ${rez.spec}`)
        const r2 = await pokreni(rez)
        if (r2.exitCode === 0 && !r2.greska) { rezultat = r2; dezurniOpis = `${rez.spec} (primarni: ${uzrok})` }
        else rezultat = { ...r2, greska: `primarni pao (${uzrok}); dežurni ${rez.spec}: ${r2.greska || `exit ${r2.exitCode}`}` }
      } else {
        this.p.logger.log(`[orchestrator] ${t.id} (${agent.id}): primarni model pao (${uzrok}) — dežurni nema put kroz CLI (davatelj bez Anthropic-kompatibilnog endpointa ili ključa)`)
      }
    } else if (dz && rezultat.exitCode === 0) {
      dz.uspjeh()
    }

    const uspjeh = rezultat.exitCode === 0 && !rezultat.greska
    this.queue.oslobodi(t.id, uspjeh)

    if (uspjeh) {
      // Jezgra NE zatvara zadatak umjesto agenta: `completed` je tvrdnja o izvršenom poslu
      // i mora doći od onoga tko ga je radio (i proći vratara ploče). Ovdje se bilježi
      // samo da je izvođač završio.
      await this.p.board.update(t.id, {
        progressNotes: [`orkestrator: izvođač ${this.p.executor.ime} završio (${agent.id})` +
          (dezurniOpis ? ` — 🔻 preko dežurnog ${dezurniOpis}` : '')],
      })
    } else {
      await this.p.board.update(t.id, {
        status: 'blocked',
        blockedReason: `spawn nije uspio: ${rezultat.greska || `exit ${rezultat.exitCode}`}`,
      })
      await this.p.notifier.notify(
        `⚠️ ${t.id} (${agent.id}): ${rezultat.greska || `exit ${rezultat.exitCode}`}`,
      )
    }
    this.p.logger.log(
      `[orchestrator] ${t.id} (${agent.id}) → exit ${rezultat.exitCode}` +
      (rezultat.greska ? ` — ${rezultat.greska}` : ''),
    )
    return rezultat
  }

  // ─── Životni ciklus ────────────────────────────────────────────────────────

  start(): void {
    if (this.radi) return
    this.radi = true
    this.p.logger.log(
      `[orchestrator] pokrenut — strop ${this.queue.strop}, ` +
      `izvođač ${this.p.executor.ime}, agenata ${this.p.agents.list().length}`,
    )
    const petlja = async () => {
      if (!this.radi) return
      try {
        await this.jedanProlaz()
      } catch (e: any) {
        this.p.logger.log(`[orchestrator] prolaz je pao: ${e?.message || e}`)
      }
      if (!this.radi) return
      this.tajmer = setTimeout(petlja, this.cfg.pollIntervalMs)
      // Petlja ne smije držati proces živim ako je domaćin gotov sa svojim poslom.
      if (typeof (this.tajmer as any)?.unref === 'function') (this.tajmer as any).unref()
    }
    void petlja()
  }

  stop(): void {
    this.radi = false
    if (this.tajmer) { clearTimeout(this.tajmer); this.tajmer = null }
    this.p.logger.log('[orchestrator] zaustavljen')
  }
}
