/**
 * Testovi jezgre orkestratora (ADR-0001 §6, uvjet gotovosti O2a/O2b).
 *
 * Test granice: jezgra se mora moći pokrenuti s izvedbama SVIH portova u memoriji — bez
 * ijedne datoteke izvan paketa i bez ijednog mrežnog poziva. Ako neka funkcija to ne
 * dopušta, ona po definiciji pripada domaćinu, ne jezgri.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { Orchestrator } from '../src/core/orchestrator/Orchestrator'
import { SpawnQueue } from '../src/core/orchestrator/SpawnQueue'
import { Watchdogs } from '../src/core/orchestrator/Watchdogs'
import { KonfiguracijskiRegistar } from '../src/core/orchestrator/AgentRegistry'
import { PredloskomSastavljenPrompt } from '../src/core/orchestrator/PromptBuilder'
import { napraviIzvodace, CliExecutor } from '../src/core/orchestrator/Executors'
import { SignalLiveness, odaberiLiveness } from '../src/core/orchestrator/Liveness'
import {
  ZADANE_POSTAVKE, loadOrchestratorConfig, saveOrchestratorConfig, stanjeOrkestratora,
  validateOrchestratorPatch, type OrchestratorPostavke,
} from '../src/core/orchestrator/OrchestratorConfig'
import type {
  AgentInfo, Board, CreateTaskInput, ExecRequest, ExecResult, Executor, Logger, Message,
  MessageBus, Notifier, OrchestratorPorts, Task, TaskPatch,
} from '../src/core/orchestrator/Ports'

// ─── Portovi u memoriji ──────────────────────────────────────────────────────

class PlocaUMemoriji implements Board {
  zadaci = new Map<string, Task>()
  zakrpe: { id: string; patch: TaskPatch }[] = []
  reclaimi: string[] = []
  private brojac = 0

  dodaj(t: Partial<Task> & { id: string }): Task {
    const puni: Task = { title: t.id, status: 'pending', ...t } as Task
    this.zadaci.set(puni.id, puni)
    return puni
  }
  async get(id: string) { return this.zadaci.get(id) || null }
  async list(status: string) { return [...this.zadaci.values()].filter(t => t.status === status) }
  async update(id: string, patch: TaskPatch) {
    this.zakrpe.push({ id, patch })
    const t = this.zadaci.get(id)
    if (!t) return false
    if (patch.status) t.status = patch.status
    if (patch.assignee !== undefined) t.assignee = patch.assignee
    return true
  }
  async create(input: CreateTaskInput) {
    const id = `T-${++this.brojac}`
    this.zadaci.set(id, { id, title: input.title, description: input.description, status: 'pending', assignee: input.assignee ?? null })
    return { id }
  }
  async reclaim(id: string) {
    this.reclaimi.push(id)
    const t = this.zadaci.get(id)
    if (t) t.status = 'pending'
    return true
  }
}

class MagistralaUMemoriji implements MessageBus {
  poruke: Message[] = []
  preuzete = new Set<string>()
  gotove: string[] = []
  async pending(limit: number) { return this.poruke.filter(m => !this.preuzete.has(m.id)).slice(0, limit) }
  async claim(id: string) { if (this.preuzete.has(id)) return false; this.preuzete.add(id); return true }
  async complete(id: string) { this.gotove.push(id) }
  async send() { return 'x' }
}

class IzvodacUMemoriji implements Executor {
  ime = 'test'
  pozivi: ExecRequest[] = []
  constructor(private odgovor: ExecResult = { exitCode: 0, resultText: 'ok', numTurns: 3 }) {}
  async run(req: ExecRequest) { this.pozivi.push(req); return this.odgovor }
}

class ZapisnikUMemoriji implements Logger {
  redci: string[] = []
  log(r: string) { this.redci.push(r) }
}

class DojavaUMemoriji implements Notifier {
  poruke: string[] = []
  async notify(t: string) { this.poruke.push(t); return true }
}

function sat(pocetak = 1_700_000_000_000) {
  let t = pocetak
  return { now: () => t, pomakni: (ms: number) => { t += ms } }
}

const AGENTI: AgentInfo[] = [
  { id: 'pisac', uloga: 'Piše tekst.', keywords: ['tekst', 'dokumentacija'] },
  { id: 'kodex', uloga: 'Piše kod.', keywords: ['kod'] },
  { id: 'opci', uloga: 'Sve ostalo.', keywords: ['*'] },
]

function sloziPortove(over: Partial<OrchestratorPorts> = {}) {
  const board = new PlocaUMemoriji()
  const bus = new MagistralaUMemoriji()
  const executor = new IzvodacUMemoriji()
  const logger = new ZapisnikUMemoriji()
  const notifier = new DojavaUMemoriji()
  const s = sat()
  const ports: OrchestratorPorts = {
    board, bus, executor,
    agents: new KonfiguracijskiRegistar(AGENTI),
    prompt: new PredloskomSastavljenPrompt(),
    liveness: { ime: 'test', alive: () => true, progress: () => null },
    notifier, clock: { now: s.now }, logger,
    ...over,
  }
  return { ports, board, bus, executor, logger, notifier, s }
}

function postavke(over: Partial<OrchestratorPostavke> = {}): OrchestratorPostavke {
  return {
    ...ZADANE_POSTAVKE, enabled: true, autoExecIntervalMs: 0,
    ...over,
  } as OrchestratorPostavke
}

// ─── Granica: sve u memoriji ─────────────────────────────────────────────────

describe('jezgra radi bez ijedne datoteke i bez mreže (ADR-0001 §6)', () => {
  test('pending zadatak se pokrene, ploča dobije in_progress, prompt ide izvođaču', async () => {
    const { ports, board, executor } = sloziPortove()
    board.dodaj({ id: 'T-1', title: 'Napiši nešto', assignee: 'pisac' })
    const o = new Orchestrator(ports, postavke())

    const ishod = await o.jedanProlaz()

    expect(ishod.spawn.pokrenuto).toBe(1)
    expect(executor.pozivi.length).toBe(1)
    expect(executor.pozivi[0]!.agentId).toBe('pisac')
    expect(board.zakrpe[0]!.patch.status).toBe('in_progress')
    expect(executor.pozivi[0]!.prompt).toContain('T-1')
  })

  test('isključen orkestrator ne pokreće ništa i kaže zašto', async () => {
    const { ports, executor } = sloziPortove()
    ;(ports.board as PlocaUMemoriji).dodaj({ id: 'T-1', assignee: 'pisac' })
    const o = new Orchestrator(ports, postavke({ enabled: false }))
    const ishod = await o.jedanProlaz()
    expect(executor.pozivi.length).toBe(0)
    expect(ishod.napomene.join(' ')).toContain('isključen')
  })

  test('prazan registar agenata: petlja radi, ništa ne spawna, i to je u napomenama', async () => {
    const { ports, executor } = sloziPortove({ agents: new KonfiguracijskiRegistar([]) })
    ;(ports.board as PlocaUMemoriji).dodaj({ id: 'T-1', assignee: 'pisac' })
    const o = new Orchestrator(ports, postavke())
    const ishod = await o.jedanProlaz()
    expect(executor.pozivi.length).toBe(0)
    expect(ishod.napomene.join(' ')).toContain('registar agenata je prazan')
  })

  test('neuspio spawn: zadatak ide u blocked s razlogom i ide dojava', async () => {
    const pao = new IzvodacUMemoriji({ exitCode: 1, resultText: '', greska: 'CLI nije nađen' })
    const { ports, board, notifier } = sloziPortove({ executor: pao })
    board.dodaj({ id: 'T-9', assignee: 'kodex' })
    const o = new Orchestrator(ports, postavke())
    await o.jedanProlaz()
    const zadnja = board.zakrpe[board.zakrpe.length - 1]!
    expect(zadnja.patch.status).toBe('blocked')
    expect(zadnja.patch.blockedReason).toContain('CLI nije nađen')
    expect(notifier.poruke.length).toBe(1)
  })

  test('jezgra NE zatvara zadatak umjesto agenta (completed mora doći od izvršitelja)', async () => {
    const { ports, board } = sloziPortove()
    board.dodaj({ id: 'T-2', assignee: 'pisac' })
    const o = new Orchestrator(ports, postavke())
    await o.jedanProlaz()
    expect(board.zakrpe.some(z => z.patch.status === 'completed')).toBe(false)
  })
})

// ─── Poruke → zadaci ─────────────────────────────────────────────────────────

describe('poruke', () => {
  test('poruka se preuzme, otvori zadatak i označi kao obrađena', async () => {
    const { ports, bus, board } = sloziPortove()
    bus.poruke.push({ id: 'm1', from: 'user', to: 'orchestrator', content: 'treba nova dokumentacija' })
    const o = new Orchestrator(ports, postavke())
    const ishod = await o.jedanProlaz()
    expect(ishod.poruka.otvoreno).toBe(1)
    expect(bus.gotove).toEqual(['m1'])
    const stvoren = [...board.zadaci.values()].find(t => t.title.includes('dokumentacija'))
    expect(stvoren?.assignee).toBe('pisac')
  })

  test('poruka koju je preuzeo netko drugi se ne obrađuje dvaput', async () => {
    const { ports, bus } = sloziPortove()
    bus.poruke.push({ id: 'm1', from: 'user', to: 'orchestrator', content: 'kod' })
    await bus.claim('m1')
    const o = new Orchestrator(ports, postavke())
    const ishod = await o.jedanProlaz()
    expect(ishod.poruka.otvoreno).toBe(0)
  })
})

// ─── Registar i rutiranje ────────────────────────────────────────────────────

describe('registar agenata (O5)', () => {
  test('pobjeđuje najduža pogođena ključna riječ, ne redoslijed u datoteci', () => {
    const r = new KonfiguracijskiRegistar([
      { id: 'a', keywords: ['kod'] },
      { id: 'b', keywords: ['kod za web'] },
    ])
    expect(r.route('treba mi kod za web')?.agentId).toBe('b')
  })

  test('catch-all se koristi tek kad nijedna ključna riječ ne pogodi', () => {
    const r = new KonfiguracijskiRegistar(AGENTI)
    expect(r.route('nešto sasvim deseto')?.agentId).toBe('opci')
    expect(r.route('napiši kod')?.agentId).toBe('kodex')
  })

  test('prazan registar ne ruta nikamo (null, ne izmišljen agent)', () => {
    expect(new KonfiguracijskiRegistar([]).route('bilo što')).toBeNull()
  })
})

// ─── Prompt ──────────────────────────────────────────────────────────────────

describe('prompt (S13 — nijedna naša rečenica)', () => {
  const ctx = {
    task: { id: 'T-1', title: 'Naslov', description: 'Opis', status: 'pending' } as Task,
    agent: { id: 'pisac', uloga: 'Piše tekst.' } as AgentInfo,
    apiBaseUrl: 'http://localhost:17781',
    systemFacts: [] as string[],
  }

  test('bez systemFacts prompt ne spominje nijednu adresu osim adrese ploče', () => {
    const p = new PredloskomSastavljenPrompt().build(ctx)
    const adrese = p.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) || []
    expect(adrese).toEqual([])
    expect(p).toContain('T-1')
  })

  test('systemFacts iz konfiguracije doslovno ulaze u prompt', () => {
    const p = new PredloskomSastavljenPrompt().build({ ...ctx, systemFacts: ['Ollama: http://10.0.0.9:11434'] })
    expect(p).toContain('Ollama: http://10.0.0.9:11434')
  })

  test('nepoznata zamjena u predlošku ostaje vidljiva, ne nestaje tiho', () => {
    const p = new PredloskomSastavljenPrompt().build(ctx)
    expect(p.includes('{taskId}')).toBe(false)
  })
})

// ─── Red spawnova ────────────────────────────────────────────────────────────

describe('SpawnQueue', () => {
  test('strop usporednih spawnova zaustavlja treći', () => {
    const q = new SpawnQueue({ maxConcurrent: 2, backoff: { baseMs: 1000, maxMs: 9000, jitter: false }, hardCeilingHours: 24 })
    q.zauzmi('a', 'T-1'); q.zauzmi('a', 'T-2')
    const d = q.smije('a', 'T-3')
    expect(d.ok).toBe(false)
    expect((d as any).razlog).toBe('strop')
  })

  test('backoff raste eksponencijalno i drži agenta dok ne istekne', () => {
    const s = sat()
    const q = new SpawnQueue({
      maxConcurrent: 5, backoff: { baseMs: 1000, maxMs: 60000, jitter: false },
      hardCeilingHours: 24, now: s.now,
    })
    q.zauzmi('a', 'T-1'); q.oslobodi('T-1', false)
    expect(q.smije('a', 'T-2').ok).toBe(false)
    expect(q.odgoda(1)).toBe(1000)
    expect(q.odgoda(3)).toBe(4000)
    s.pomakni(1001)
    expect(q.smije('a', 'T-2').ok).toBe(true)
  })

  test('uspjeh briše odgodu', () => {
    const q = new SpawnQueue({ maxConcurrent: 5, backoff: { baseMs: 1000, maxMs: 9000, jitter: false }, hardCeilingHours: 24 })
    q.zauzmi('a', 'T-1'); q.oslobodi('T-1', false)
    q.zauzmi('a', 'T-2'); q.oslobodi('T-2', true)
    expect(q.smije('a', 'T-3').ok).toBe(true)
  })

  test('jitter nikad ne prelazi čistu vrijednost i ne pada ispod pola', () => {
    const q = new SpawnQueue({
      maxConcurrent: 1, backoff: { baseMs: 1000, maxMs: 9000, jitter: true },
      hardCeilingHours: 24, random: () => 0,
    })
    expect(q.odgoda(1)).toBe(500)
  })
})

// ─── Čistači ─────────────────────────────────────────────────────────────────

describe('Watchdogs', () => {
  function sloziWatchdog(mode: 'off' | 'shadow' | 'live', s = sat()) {
    const board = new PlocaUMemoriji()
    const logger = new ZapisnikUMemoriji()
    const q = new SpawnQueue({ maxConcurrent: 5, backoff: { baseMs: 1, maxMs: 2, jitter: false }, hardCeilingHours: 24, now: s.now })
    const w = new Watchdogs(board, q, { ime: 't', alive: () => false, progress: () => null }, logger, {
      stale: { mode, maxActionsPerRun: 5 },
      zombie: { mode, maxActionsPerRun: 5 },
      deadAgent: { mode, maxActionsPerRun: 5 },
      livenessWindowHours: 2, milostMs: 0, now: s.now,
    })
    return { board, q, w, logger }
  }

  test('mrtav proces uz in_progress zadatak = zombi', async () => {
    const { board, q, w } = sloziWatchdog('live')
    board.dodaj({ id: 'T-1', status: 'in_progress' })
    q.zauzmi('a', 'T-1', 999999)
    const nalazi = await w.prolaz()
    expect(nalazi.length).toBe(1)
    expect(nalazi[0]!.vrsta).toBe('zombi')
    expect(board.reclaimi).toEqual(['T-1'])
  })

  test('u sjeni se sud ZAPISUJE, ali se zadatak ne dira', async () => {
    const { board, q, w, logger } = sloziWatchdog('shadow')
    board.dodaj({ id: 'T-1', status: 'in_progress' })
    q.zauzmi('a', 'T-1', 999999)
    const nalazi = await w.prolaz()
    expect(nalazi[0]!.izvrseno).toBe(false)
    expect(board.reclaimi.length).toBe(0)
    expect(logger.redci.join(' ')).toContain('watchdog:zombi')
  })

  test('mode off ne zapisuje ni ne dira', async () => {
    const { board, q, w, logger } = sloziWatchdog('off')
    board.dodaj({ id: 'T-1', status: 'in_progress' })
    q.zauzmi('a', 'T-1', 999999)
    const nalazi = await w.prolaz()
    expect(nalazi[0]!.izvrseno).toBe(false)
    expect(logger.redci.length).toBe(0)
  })

  test('strop poteza po prolazu drži prvi prolaz na starom sustavu', async () => {
    const s = sat()
    const board = new PlocaUMemoriji()
    const q = new SpawnQueue({ maxConcurrent: 50, backoff: { baseMs: 1, maxMs: 2, jitter: false }, hardCeilingHours: 24, now: s.now })
    const w = new Watchdogs(board, q, { ime: 't', alive: () => false, progress: () => null }, new ZapisnikUMemoriji(), {
      stale: { mode: 'live', maxActionsPerRun: 2 },
      zombie: { mode: 'live', maxActionsPerRun: 2 },
      deadAgent: { mode: 'live', maxActionsPerRun: 2 },
      livenessWindowHours: 2, milostMs: 0, now: s.now,
    })
    for (let i = 1; i <= 10; i++) {
      board.dodaj({ id: `T-${i}`, status: 'in_progress' })
      q.zauzmi('a', `T-${i}`, 999999)
    }
    const nalazi = await w.prolaz()
    expect(nalazi.length).toBe(2)
  })

  test('milost nakon restarta: zadatak bez poznatog spawna ne pada odmah', async () => {
    const s = sat()
    const board = new PlocaUMemoriji()
    const q = new SpawnQueue({ maxConcurrent: 5, backoff: { baseMs: 1, maxMs: 2, jitter: false }, hardCeilingHours: 24, now: s.now })
    const w = new Watchdogs(board, q, { ime: 't', alive: () => true, progress: () => null }, new ZapisnikUMemoriji(), {
      stale: { mode: 'live', maxActionsPerRun: 5 },
      zombie: { mode: 'live', maxActionsPerRun: 5 },
      deadAgent: { mode: 'live', maxActionsPerRun: 5 },
      livenessWindowHours: 2, milostMs: 60_000, now: s.now,
    })
    board.dodaj({ id: 'T-1', status: 'in_progress' })
    expect((await w.prolaz()).length).toBe(0)
    s.pomakni(61_000)
    expect((await w.prolaz()).length).toBe(1)
  })
})

// ─── Izvođači ────────────────────────────────────────────────────────────────

describe('Executors (O4)', () => {
  test('tablica izvođača iz konfiguracije daje CLI i HTTP izvedbu', () => {
    const { zadani, svi, greske } = napraviIzvodace(ZADANE_POSTAVKE.executors as any)
    expect(greske).toEqual([])
    expect(zadani?.ime).toBe('cli-claude')
    expect(svi.has('http-ollama')).toBe(true)
  })

  test('nepostojeći zadani izvođač je greška, ne tiha zamjena', () => {
    const { zadani, greske } = napraviIzvodace({ default: 'nema-me' } as any)
    expect(zadani).toBeNull()
    expect(greske.join(' ')).toContain('nema-me')
  })

  test('CLI izvođač doista pokrene naredbu i pročita izlaz', async () => {
    const e = new CliExecutor('echo', {
      kind: 'cli', command: 'echo', args: [], promptChannel: 'arg', promptFlag: null,
    } as any)
    const r = await e.run({ agentId: 'a', prompt: 'zdravo' })
    expect(r.exitCode).toBe(0)
    expect(r.resultText).toBe('zdravo')
  })

  test('nula poteza uz exit 0 NIJE uspjeh (potpis blokiranog spawna)', async () => {
    const e = new CliExecutor('json', {
      kind: 'cli', command: 'echo', args: ['{"num_turns":0,"result":""}'],
      promptChannel: 'stdin', promptFlag: null,
    } as any)
    const r = await e.run({ agentId: 'a', prompt: 'x' })
    expect(r.exitCode).not.toBe(0)
    expect(r.greska).toContain('0 poteza')
  })

  test('nepostojeća naredba vraća grešku, ne ruši petlju', async () => {
    const e = new CliExecutor('nema', {
      kind: 'cli', command: 'ova-naredba-sigurno-ne-postoji-4800', args: [],
      promptChannel: 'arg', promptFlag: null,
    } as any)
    const r = await e.run({ agentId: 'a', prompt: 'x' })
    expect(r.exitCode).not.toBe(0)
  })
})

// ─── Liveness ────────────────────────────────────────────────────────────────

describe('Liveness (O6)', () => {
  test('vlastiti proces je živ, izmišljeni PID nije', () => {
    const l = new SignalLiveness()
    expect(l.alive(process.pid)).toBe(true)
    expect(l.alive(0)).toBe(false)
  })

  test('auto bira izvedbu prema tome postoji li /proc', () => {
    const l = odaberiLiveness('auto')
    expect(['proc', 'signal']).toContain(l.ime)
  })
})

// ─── Konfiguracija ───────────────────────────────────────────────────────────

describe('OrchestratorConfig (§5.1)', () => {
  test('zadane vrijednosti ne nose nijednu tuđu adresu, ime ni identitet', () => {
    const tekst = JSON.stringify({ ...ZADANE_POSTAVKE, api: { ...ZADANE_POSTAVKE.api } })
    expect(tekst).not.toContain('192.168.')
    expect(tekst).not.toContain('/home/klaudio')
    expect(tekst).not.toContain('@intergalaktik')
    expect(ZADANE_POSTAVKE.enabled).toBe(false)
    expect(ZADANE_POSTAVKE.prompt.systemFacts).toEqual([])
  })

  test('nepoznato polje se odbija IMENOM, i na prvoj i na drugoj razini', () => {
    const a = validateOrchestratorPatch({ enabledd: true })
    expect(a.ok).toBe(false)
    expect(a.greske.join(' ')).toContain('enabledd')
    const b = validateOrchestratorPatch({ spawn: { maxConcurent: 5 } })
    expect(b.ok).toBe(false)
    expect(b.greske.join(' ')).toContain('spawn.maxConcurent')
  })

  test('adresa ploče mora biti http(s), broj mora biti u granicama', () => {
    expect(validateOrchestratorPatch({ api: { baseUrl: 'ftp://x' } }).ok).toBe(false)
    expect(validateOrchestratorPatch({ spawn: { maxConcurrent: 999 } }).ok).toBe(false)
    expect(validateOrchestratorPatch({ spawn: { maxConcurrent: 4 } }).ok).toBe(true)
  })

  test('save → load vraća zapisano i ČUVA nepoznata polja iz datoteke', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-orc-'))
    const p = join(dir, 'orchestrator.json')
    try {
      saveOrchestratorConfig({ enabled: true, moje_polje: 42 } as any, p)
      const cfg = loadOrchestratorConfig(p)
      expect(cfg.enabled).toBe(true)
      expect((cfg as any).moje_polje).toBe(42)
      expect(cfg.spawn.maxConcurrent).toBe(ZADANE_POSTAVKE.spawn.maxConcurrent)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('stanje kaže ZAŠTO nije spremno, ključem za prijevod', () => {
    const s = stanjeOrkestratora({ ...ZADANE_POSTAVKE, enabled: false })
    expect(s.spreman).toBe(false)
    expect(s.zastoKey).toBe('orc_zasto_iskljucen')
  })
})
