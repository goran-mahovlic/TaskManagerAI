/**
 * Pragovi vrata autonomije kao POSTAVKA (tablica `settings`, ključevi autonomy.*),
 * promjenjivi uživo s Config stranice — isti obrazac kao strop usporednih agenata.
 *
 * Što se dokazuje:
 *  • bez postavke vrijede zadane 70/85/95 (sesija) i 90 (tjedan);
 *  • PUT validira cijele postotke 10–100 i redoslijed autonomija < oprez < blokada;
 *    djelomičan PUT se spaja s trenutačnim, audit ide po ključu u `settings_history`;
 *  • nevaljan zapis u bazi → zadnja dobra vrijednost, pa zadano (nikad „bez praga");
 *  • čitač vidi promjenu nakon keša (≤5 s) i javlja „autonomija 70 → 80 (…)";
 *  • `GET/PUT /api/config/autonomy` na pravom poslužitelju nad praznom instalacijom.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  AUTONOMY_DEFAULTS,
  getAutonomyThresholds,
  setAutonomyThresholds,
  parseAutonomyInput,
  autonomyThresholdsHistory,
  createAutonomyThresholdsReader,
  formatAutonomyChanges,
  usageZone,
} from '../src/core/AutonomyThresholdSetting'
import { ensureSettingsSchema } from '../src/core/ConcurrencySetting'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

function freshDb(): Database {
  const db = new Database(':memory:')
  ensureSettingsSchema(db)
  return db
}

describe('postavka', () => {
  test('prazno → zadano 70/85/95/90', () => {
    const s = getAutonomyThresholds(freshDb())
    expect(s.values).toEqual({ sessionAutonomy: 70, sessionCaution: 85, sessionBlock: 95, weeklyBlock: 90 })
    expect(s.source).toBe('default')
  })

  test('validacija: raspon, cijeli broj, redoslijed, nepoznato polje', () => {
    expect(parseAutonomyInput({ sessionAutonomy: 9 }, AUTONOMY_DEFAULTS).ok).toBe(false)
    expect(parseAutonomyInput({ weeklyBlock: 85.5 }, AUTONOMY_DEFAULTS).ok).toBe(false)
    expect(parseAutonomyInput({ sessionAutonomy: 85 }, AUTONOMY_DEFAULTS).ok).toBe(false)
    expect(parseAutonomyInput({ sessionAutonomi: 80 }, AUTONOMY_DEFAULTS).ok).toBe(false)
    expect(parseAutonomyInput({ by: 'x' }, AUTONOMY_DEFAULTS).ok).toBe(false)
    expect(parseAutonomyInput({ sessionAutonomy: 80, by: 'x' }, AUTONOMY_DEFAULTS).ok).toBe(true)
  })

  test('upis + audit samo za promijenjene ključeve; nevaljan upis ne piše ništa', () => {
    const db = freshDb()
    expect(() => setAutonomyThresholds(db, { sessionAutonomy: 90 }, 'admin')).toThrow()
    const ch = setAutonomyThresholds(db, { sessionAutonomy: 80 }, 'admin', 'config')
    expect(ch.changes).toEqual([{ field: 'sessionAutonomy', key: 'autonomy.session_autonomy', oldValue: 70, newValue: 80 }])
    expect(autonomyThresholdsHistory(db).length).toBe(1)
    expect(formatAutonomyChanges(ch.changes, ch.changedBy, ch.source)).toBe('autonomija 70 → 80 (admin, config)')
  })

  test('čitač: keš ≤5 s, pokvaren zapis → zadnja dobra', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-aut-'))
    try {
      const path = join(dir, 'tm.db')
      const db = new Database(path)
      ensureSettingsSchema(db)
      let t = 0
      const read = createAutonomyThresholdsReader({ dbPath: path, ttlMs: 60_000, now: () => t })
      expect(read().sessionAutonomy).toBe(70)
      setAutonomyThresholds(db, { sessionAutonomy: 80 }, 'admin', 'config')
      t = 4999; expect(read().sessionAutonomy).toBe(70)
      t = 5000; expect(read().sessionAutonomy).toBe(80)
      db.query(`UPDATE settings SET value = 'x' WHERE key = 'autonomy.session_autonomy'`).run()
      t = 10_000; expect(read().sessionAutonomy).toBe(80)
      db.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('zona za klizač', () => {
    expect(usageZone(73, 40, AUTONOMY_DEFAULTS)).toEqual({ session: 'task-by-task', weeklyBlocked: false })
    expect(usageZone(73, 40, { ...AUTONOMY_DEFAULTS, sessionAutonomy: 80 }).session).toBe('full')
  })
})

describe('HTTP /api/config/autonomy (prava ploča, prazna instalacija)', () => {
  let p: Posluzitelj | null = null
  afterAll(() => spusti(p))

  test('GET zadano → PUT 80 → GET 80, povijest i zona', async () => {
    p = await podigni()
    mkdirSync(join(p.dom, 'data'), { recursive: true })
    writeFileSync(join(p.dom, 'data', 'session_usage.cache.json'), JSON.stringify({
      cached_at: Date.now() / 1000, entry: { session_percent: 73, weekly_percent: 40, status: 'allowed' },
    }))
    const g = await (await fetch(`${p.url}/api/config/autonomy`)).json() as any
    expect(g).toMatchObject({ sessionAutonomy: 70, sessionCaution: 85, sessionBlock: 95, weeklyBlock: 90, source: 'default' })

    const bad = await fetch(`${p.url}/api/config/autonomy`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionCaution: 99 }) })
    expect(bad.status).toBe(400)

    const r = await fetch(`${p.url}/api/config/autonomy`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionAutonomy: 80, by: 'admin' }) })
    expect(r.status).toBe(200)
    const b = await r.json() as any
    expect(b.sessionAutonomy).toBe(80)
    expect(b.history[0]).toMatchObject({ key: 'autonomy.session_autonomy', oldValue: 70, newValue: 80, changedBy: 'admin' })
    if (b.usage?.sessionPercent === 73) expect(b.zone.session).toBe('full')
  }, 30_000)
})
