/**
 * TASK-5170: GET/PUT /api/config/raspored na PRAVOJ ploči nad praznom instalacijom (dizajn TASK-5169 §5, §6).
 *  • spremanje s auditom, 409 za zastarjelu osnovu, ↺ zadano, stroga validacija (400, nula upisa);
 *  • biljeg `x-regoc-proba: 1` = provjera, ne posao: odgovor kaže što BI se zapisalo, baza i ploča ostaju iste;
 *  • test nepromjenjivosti (§6.4): GET ruta vrijednosti bajt-identičan prije i poslije PUT-ova rasporeda,
 *    a novi retci u `settings_history` imaju SAMO key='config.raspored';
 *  • /config-raspored.js poslužuje logiku + uređivač, stranica ima JEDAN gumb #cr-uredi.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'path'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

let p: Posluzitelj | null = null
afterAll(() => spusti(p))

const RUTA = '/api/config/raspored'
const VRIJEDNOSTI = ['/api/config/concurrency', '/api/config/autonomy']
const R = (w = 1) => ({
  v: 1, redoslijed: ['info-autonomija-card', 'info-concurrency-card'],
  kartice: { 'info-autonomija-card': { w: 4, h: null }, 'info-concurrency-card': { w, h: 240 } },
})
const put = (tijelo: unknown, zaglavlja: Record<string, string> = {}) =>
  fetch(`${p!.url}${RUTA}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...zaglavlja }, body: typeof tijelo === 'string' ? tijelo : JSON.stringify(tijelo) })
const get = async () => (await fetch(`${p!.url}${RUTA}`)).json() as Promise<any>
function povijest(): Array<{ key: string; new_value: string; source: string }> {
  const db = new Database(join(p!.dom, 'data', 'tasks.db'), { readonly: true })
  try { return db.query('SELECT key, new_value, source FROM settings_history ORDER BY id').all() as any } finally { db.close() }
}
// Bajt-identično se uspoređuju POSTAVKE: `usage`/`gate`/`zone` su živo mjerenje potrošnje (starost snimke
// raste svake ms), ne vrijednost koju bi raspored mogao dirnuti — zato se izuzimaju prije usporedbe.
const MJERENJE = new Set(['usage', 'gate', 'zone'])
const snimiVrijednosti = async () => Promise.all(VRIJEDNOSTI.map(async u =>
  JSON.stringify(JSON.parse(await (await fetch(`${p!.url}${u}`)).text()), (k, v) => (MJERENJE.has(k) ? undefined : v))))

describe('HTTP /api/config/raspored', () => {
  test('cijeli tijek: prazno → proba → spremi → 409 → nevaljano → zadano; vrijednosti netaknute', async () => {
    p = await podigni()
    const prijeVrijednosti = await snimiVrijednosti()
    const prijePovijesti = povijest().length
    const brojZadataka = ((await (await fetch(`${p.url}/api/tasks`)).json()) as any[]).length

    const g0 = await get()
    expect(g0).toMatchObject({ raspored: null, osnova: null, povijest: [] })

    // x-regoc-proba: valjan zahtjev prolazi SVE provjere, ali se ništa ne zapisuje
    const pr = await put({ raspored: R(), osnova: null, by: 'test' }, { 'x-regoc-proba': '1' })
    expect(pr.status).toBe(200)
    const prb = await pr.json() as any
    expect(prb).toMatchObject({ proba: true, promjena: true })
    expect(prb.raspored).toEqual(R())
    expect((await get()).raspored).toBeNull()
    expect(povijest().length).toBe(prijePovijesti)
    // proba s nevaljanim tijelom i dalje vraća 400 (provjera je stvarna)
    expect((await put({ raspored: R(), maxConcurrent: 9 }, { 'x-regoc-proba': '1' })).status).toBe(400)

    // pravo spremanje
    const r1 = await put({ raspored: R(), osnova: null, by: 'vlasnik', source: 'config-raspored' })
    expect(r1.status).toBe(200)
    const b1 = await r1.json() as any
    expect(b1.raspored).toEqual(R())
    expect(b1.osnova).toBeTruthy()
    expect(b1.povijest[0]).toMatchObject({ key: 'config.raspored', changedBy: 'vlasnik', source: 'config-raspored' })

    // drugi uređaj sa zastarjelom osnovom → 409, raspored ostaje
    const r409 = await put({ raspored: R(3), osnova: null, by: 'mobitel' })
    expect(r409.status).toBe(409)
    expect((await get()).raspored).toEqual(R())

    // stroga validacija: sve 400 i nula upisa
    const n = povijest().length
    for (const t of [
      { raspored: R(), maxConcurrent: 9, osnova: b1.osnova },
      { raspored: { ...R(), maxConcurrent: 9 }, osnova: b1.osnova },
      { raspored: { ...R(), kartice: { 'info-rag-card': { w: 9, h: null } } }, osnova: b1.osnova },
      { raspored: { ...R(), redoslijed: ['info-card"><script>'] }, osnova: b1.osnova },
      { osnova: b1.osnova },
    ]) expect((await put(t)).status).toBe(400)
    expect((await put('{ne json')).status).toBe(400)
    expect((await put('x'.repeat(20000))).status).toBe(413)
    expect(povijest().length).toBe(n)

    // ↺ Zadano
    const rz = await put({ zadano: true, osnova: b1.osnova, by: 'vlasnik' })
    expect(rz.status).toBe(200)
    const gz = await get()
    expect(gz).toMatchObject({ raspored: null, osnova: null })
    expect(gz.povijest[0]).toMatchObject({ newValue: 'zadano' })

    // §6.4: vrijednosti bajt-identične; novi retci povijesti samo za config.raspored
    expect(await snimiVrijednosti()).toEqual(prijeVrijednosti)
    const novi = povijest().slice(prijePovijesti)
    expect(novi.length).toBe(2)
    expect(novi.every(r => r.key === 'config.raspored')).toBe(true)
    // ploča nije dobila nijedan zadatak
    expect(((await (await fetch(`${p.url}/api/tasks`)).json()) as any[]).length).toBe(brojZadataka)
  }, 30_000)

  test('stranica ima JEDAN gumb uređivača i učitava /config-raspored.js', async () => {
    if (!p) p = await podigni()
    const html = await (await fetch(`${p.url}/`)).text()
    expect(html.match(/id="cr-uredi"/g)?.length).toBe(1)
    expect(html).toContain('<script src="/config-raspored.js"')
    const js = await fetch(`${p.url}/config-raspored.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('javascript')
    const t = await js.text()
    expect(t).toContain('window.CfgRasporedLogika')
    expect(t).toContain('window.CfgRaspored')
  }, 30_000)
})
