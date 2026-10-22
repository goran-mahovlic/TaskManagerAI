/**
 * Petlja orkestratora U PROCESU PLOČE (gumb Pokreni/Zaustavi na Config → Orkestrator), po
 * uzoru na Telegram poller „način A". Ovdje se ne testira jezgra (tests/orchestrator.test.ts)
 * nego omotač: brava (jedna petlja nad jednom pločom), trajno stanje (preživi restart ploče),
 * autostart, i da `scripts/orchestrator.ts` odbija krenuti dok ploča drži bravu.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OrchestratorPetlja, type PetljaSastav } from '../src/OrchestratorPetlja'
import { ZADANE_POSTAVKE, type OrchestratorPostavke } from '../src/core/orchestrator/OrchestratorConfig'
import type { IshodProlaza } from '../src/core/orchestrator/Orchestrator'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tm-petlja-')) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* nema veze */ } })

function cfg(over: Partial<OrchestratorPostavke> = {}): OrchestratorPostavke {
  return { ...ZADANE_POSTAVKE, enabled: true, pollIntervalMs: 5, ...over } as OrchestratorPostavke
}

/** Lažni sastav: orkestrator čiji prolaz samo broji i „pokreće" jedan spawn. */
function sastav(over: { cfg?: OrchestratorPostavke; prazan?: boolean; greske?: string[] } = {}) {
  let prolaza = 0
  const s: PetljaSastav = {
    cfg: over.cfg || cfg(),
    greske: over.greske || [],
    orkestrator: over.prazan ? null : {
      async jedanProlaz(): Promise<IshodProlaza> {
        prolaza++
        return { spawn: { pokrenuto: 1, odbijeno: 0 }, poruka: { obradjeno: 0, preskoceno: 0 }, napomene: [] } as any
      },
    },
  }
  return { s, prolaza: () => prolaza }
}

function petlja(sastavi: () => PetljaSastav, log: string[] = []) {
  return new OrchestratorPetlja({
    stanjePath: join(dir, 'orchestrator-petlja.json'),
    bravaPath: join(dir, 'orchestrator.lock'),
    sastavi,
    log: r => log.push(r),
    // Testovi ne smiju čitati živu kočnicu stroja; kočnica ima vlastite testove niže.
    pauza: () => false,
  })
}

describe('start / stop', () => {
  test('start uzme bravu s našim PID-om, upiše trajno stanje i vrti prolaze', async () => {
    const { s, prolaza } = sastav()
    const p = petlja(() => s)
    const r = p.start()
    expect(r.ok).toBe(true)
    expect(readFileSync(join(dir, 'orchestrator.lock'), 'utf-8').trim()).toBe(String(process.pid))
    expect(JSON.parse(readFileSync(join(dir, 'orchestrator-petlja.json'), 'utf-8')).ukljucen).toBe(true)
    await Bun.sleep(40)
    expect(prolaza()).toBeGreaterThanOrEqual(2)
    const st = p.stanje()
    expect(st.radi).toBe(true)
    expect(st.prolaza).toBeGreaterThanOrEqual(2)
    expect(st.pokrenuto).toBeGreaterThanOrEqual(2)
    expect(st.zadnjiProlaz).toBeTruthy()
    expect(st.pokrenutaU).toBeTruthy()
    p.stop()
  })

  test('drugi start dok radi je bez učinka (ne pokreće drugu petlju)', async () => {
    const { s, prolaza } = sastav()
    const p = petlja(() => s)
    expect(p.start().ok).toBe(true)
    const r2 = p.start()
    expect(r2.ok).toBe(true)
    expect(r2.razlog || '').toContain('već')
    await Bun.sleep(30)
    const n = prolaza()
    p.stop()
    // Jedna petlja na 5 ms u 30 ms ne može napraviti 20 prolaza; dvije bi se približile.
    expect(n).toBeLessThan(12)
  })

  test('stop prestaje vrtjeti, pušta bravu i trajno stanje postaje isključeno', async () => {
    const { s, prolaza } = sastav()
    const p = petlja(() => s)
    p.start()
    await Bun.sleep(20)
    p.stop()
    const n = prolaza()
    await Bun.sleep(30)
    expect(prolaza()).toBe(n)
    expect(p.stanje().radi).toBe(false)
    expect(existsSync(join(dir, 'orchestrator.lock'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'orchestrator-petlja.json'), 'utf-8')).ukljucen).toBe(false)
  })

  test('isključen orkestrator (enabled: false): start odbija i kaže zašto', () => {
    const { s } = sastav({ cfg: cfg({ enabled: false }) })
    const p = petlja(() => s)
    const r = p.start()
    expect(r.ok).toBe(false)
    expect(r.razlog || '').toContain('isključen')
    expect(existsSync(join(dir, 'orchestrator.lock'))).toBe(false)
  })

  test('sastav bez orkestratora (nema izvođača): start odbija s razlozima sastava', () => {
    const { s } = sastav({ prazan: true, greske: ['nijedan izvođač nije podešen'] })
    const p = petlja(() => s)
    const r = p.start()
    expect(r.ok).toBe(false)
    expect(r.razlog || '').toContain('nijedan izvođač')
  })
})

describe('jedna petlja nad jednom pločom (brava)', () => {
  test('bravu drži drugi ŽIVI proces: start odbija, stanje imenuje taj proces', () => {
    mkdirSync(dir, { recursive: true })
    // Roditelj ovog test-procesa je živ i nije mi — to je „zaseban proces" u testu.
    const tudji = process.ppid
    writeFileSync(join(dir, 'orchestrator.lock'), String(tudji))
    const { s } = sastav()
    const p = petlja(() => s)
    expect(p.stanje().drugiProces).toBe(tudji)
    const r = p.start()
    expect(r.ok).toBe(false)
    expect(r.razlog || '').toContain(String(tudji))
    expect(p.stanje().radi).toBe(false)
  })

  test('brava mrtvog procesa se preuzima', () => {
    writeFileSync(join(dir, 'orchestrator.lock'), '999999')
    const { s } = sastav()
    const p = petlja(() => s)
    expect(p.stanje().drugiProces).toBeNull()
    expect(p.start().ok).toBe(true)
    p.stop()
  })

  test('scripts/orchestrator.ts odbija krenuti dok ploča drži bravu (izlaz 1, poruka s PID-om)', () => {
    const home = join(dir, 'home')
    mkdirSync(join(home, 'data'), { recursive: true })
    writeFileSync(join(home, 'data', 'orchestrator.lock'), String(process.pid))
    const r = Bun.spawnSync(['bun', 'scripts/orchestrator.ts', '--jednom'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, TM_HOME: home, TM_ORCHESTRATOR_ENABLED: '1' },
    })
    const izlaz = r.stdout.toString() + r.stderr.toString()
    expect(r.exitCode).toBe(1)
    expect(izlaz).toContain(String(process.pid))
    expect(izlaz).toContain('već radi')
  })
})

describe('autostart (preživi restart ploče)', () => {
  test('trajno stanje uključeno → autostart pokreće', async () => {
    writeFileSync(join(dir, 'orchestrator-petlja.json'), JSON.stringify({ ukljucen: true }))
    const { s } = sastav()
    const p = petlja(() => s)
    expect(p.autostart().ok).toBe(true)
    expect(p.stanje().radi).toBe(true)
    p.stop()
  })

  test('trajno stanje isključeno ili ga nema → autostart ne pokreće i to nije greška', () => {
    const { s } = sastav()
    const p = petlja(() => s)
    const r = p.autostart()
    expect(r.ok).toBe(false)
    expect(p.stanje().radi).toBe(false)
    expect(existsSync(join(dir, 'orchestrator.lock'))).toBe(false)
  })

  test('trajno stanje uključeno, ali orkestrator isključen u konfiguraciji → ne pokreće, razlog u dnevniku', () => {
    writeFileSync(join(dir, 'orchestrator-petlja.json'), JSON.stringify({ ukljucen: true }))
    const { s } = sastav({ cfg: cfg({ enabled: false }) })
    const log: string[] = []
    const p = petlja(() => s, log)
    expect(p.autostart().ok).toBe(false)
    expect(p.stanje().radi).toBe(false)
    expect(log.join('\n')).toContain('isključen')
  })
})

// ─── TASK-5715 (nalazi C1, Ž3 i Ž5 pregleda TASK-5712) ────────────────────────

describe('C1: ručna kočnica zaustavlja petlju s ploče', () => {
  function petljaSKocnicom(sastavi: () => PetljaSastav, kocnica: () => boolean, log: string[] = []) {
    return new OrchestratorPetlja({
      stanjePath: join(dir, 'orchestrator-petlja.json'),
      bravaPath: join(dir, 'orchestrator.lock'),
      sastavi, log: r => log.push(r), pauza: kocnica,
    })
  }

  test('Pokreni pod kočnicom: odbijeno, 0 prolaza, brava se ne uzima, želja se ne mijenja', async () => {
    const { s, prolaza } = sastav()
    const p = petljaSKocnicom(() => s, () => true)
    const r = p.start()
    expect(r.ok).toBe(false)
    expect(r.razlog || '').toContain('kočnica')
    await Bun.sleep(30)
    expect(prolaza()).toBe(0)
    expect(existsSync(join(dir, 'orchestrator.lock'))).toBe(false)
    expect(existsSync(join(dir, 'orchestrator-petlja.json'))).toBe(false)
    expect(p.stanje().razlog || '').toContain('kočnica')
  })

  test('autostart pod kočnicom ne kreće; želja ostaje za kasnije', async () => {
    writeFileSync(join(dir, 'orchestrator-petlja.json'), JSON.stringify({ ukljucen: true }))
    const { s, prolaza } = sastav()
    const log: string[] = []
    const p = petljaSKocnicom(() => s, () => true, log)
    expect(p.autostart().ok).toBe(false)
    await Bun.sleep(30)
    expect(prolaza()).toBe(0)
    expect(p.stanje().radi).toBe(false)
    expect(p.stanje().zeljeno).toBe(true)
    expect(log.join('\n')).toContain('kočnica')
  })

  test('zadana kočnica je pause.state.json (REGOC_PAUSE_STATE u testu)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'OrchestratorPetlja.ts'), 'utf-8')
    expect(src).toContain('readPauseState().paused')
  })
})

describe('Ž3: Zaustavi→Pokreni usred prolaza ne daje dva istodobna prolaza', () => {
  test('najviše jedan prolaz u letu', async () => {
    let uLetu = 0, najvise = 0, prolaza = 0
    const s: PetljaSastav = {
      cfg: cfg({ pollIntervalMs: 1 } as any), greske: [],
      orkestrator: {
        async jedanProlaz() {
          uLetu++; najvise = Math.max(najvise, uLetu); prolaza++
          await Bun.sleep(15)
          uLetu--
          return { spawn: { pokrenuto: 0, odbijeno: 0 }, poruka: {}, napomene: [] } as any
        },
      },
    }
    const p = petlja(() => s)
    expect(p.start().ok).toBe(true)
    await Bun.sleep(3)
    for (let i = 0; i < 3; i++) { p.stop(); expect(p.start().ok).toBe(true); await Bun.sleep(2) }
    await Bun.sleep(60)
    p.stop()
    expect(prolaza).toBeGreaterThan(1)
    expect(najvise).toBe(1)
  })
})

describe('Ž5: promjena želje se bilježi (tko)', () => {
  test('start/stop upisuju tko je mijenjao', () => {
    const { s } = sastav()
    const log: string[] = []
    const p = petlja(() => s, log)
    p.start('ploca 127.0.0.1')
    expect(JSON.parse(readFileSync(join(dir, 'orchestrator-petlja.json'), 'utf-8')).tko).toBe('ploca 127.0.0.1')
    p.stop('ploca 127.0.0.1')
    expect(log.join('\n')).toContain('isključena (ploca 127.0.0.1)')
  })
})
