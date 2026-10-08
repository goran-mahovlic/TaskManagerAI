/**
 * TASK-5346: PUT /api/config/skupina/<ime> na PRAVOJ ploči nad praznom instalacijom.
 *  • mail: sva polja jednim pozivom → jedan redak `skupina.email` u settings_history s popisom ključeva;
 *  • djelomično nevaljana skupina (loš port) → 400, pogreška uz polje, datoteka i audit netaknuti;
 *  • Telegram: prazan bot token ne briše postojeći; token nikad u odgovor ni audit;
 *  • stranica: Integracije više nemaju „Spremi” po polju, nego jedan po skupini.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

let p: Posluzitelj | null = null
afterAll(() => spusti(p))

const put = (ime: string, tijelo: unknown) =>
  fetch(`${p!.url}/api/config/skupina/${ime}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tijelo) })
function audit(): Array<{ key: string; old_value: string | null; new_value: string; changed_by: string; source: string }> {
  const db = new Database(join(p!.dom, 'data', 'tasks.db'), { readonly: true })
  try { return db.query("SELECT key, old_value, new_value, changed_by, source FROM settings_history WHERE key LIKE 'skupina.%' ORDER BY id").all() as any } finally { db.close() }
}
const procitaj = (put: string) => (existsSync(put) ? readFileSync(put, 'utf-8') : '')

describe('HTTP /api/config/skupina', () => {
  test('mail: skupina jednim pozivom, nevaljana ne zapisuje ništa, jedan audit redak', async () => {
    p = await podigni()
    const g0 = await (await fetch(`${p.url}/api/email/config`)).json() as any
    const putanja = g0.putanja as string

    // 1) djelomično nevaljano: host valjan, port izvan granica → ništa se ne zapisuje
    const prije = procitaj(putanja)
    const r0 = await put('email', { polja: { ukljucen: true, smtp: { host: 'smtp.primjer.hr', port: 99999 } }, by: 'test' })
    expect(r0.status).toBe(400)
    const b0 = await r0.json() as any
    expect(Object.keys(b0.greskePoPolju)).toEqual(['smtp.port'])
    expect(procitaj(putanja)).toBe(prije)
    expect(audit().length).toBe(0)

    // 2) valjano: sva polja skupine jednim pozivom
    const r1 = await put('email', { polja: { ukljucen: true, smtp: { host: 'smtp.primjer.hr', port: 465, korisnik: 'ana' }, primatelji: ['a@primjer.hr'] }, by: 'vlasnik' })
    expect(r1.status).toBe(200)
    const b1 = await r1.json() as any
    expect(b1.ok).toBe(true)
    expect(b1.promijenjeno).toEqual(['primatelji', 'smtp.host', 'smtp.korisnik', 'smtp.port', 'ukljucen'])
    const g1 = await (await fetch(`${p.url}/api/email/config`)).json() as any
    expect(g1.postavke.smtp).toMatchObject({ host: 'smtp.primjer.hr', port: 465, korisnik: 'ana' })
    expect(g1.postavke.ukljucen).toBe(true)
    const a = audit()
    expect(a.length).toBe(1)
    expect(a[0]).toMatchObject({ key: 'skupina.email', old_value: null, changed_by: 'vlasnik', source: 'config-skupina' })
    expect(JSON.parse(a[0]!.new_value).kljucevi).toEqual(b1.promijenjeno)

    // 3) nepoznata skupina → 404
    expect((await put('nepostoji', { polja: { a: 1 } })).status).toBe(404)
  }, 30000)

  test('Telegram: prazan token ne briše postojeći; token nikad u odgovor ni audit', async () => {
    const TOKEN = '123456:TAJNI-TOKEN-ZA-TEST-abcdefghijklmnop'
    const r1 = await put('telegram', { polja: { botToken: TOKEN, chatId: '-1001234567890', prefix: '🔔' } })
    expect(r1.status).toBe(200)
    const t1 = await r1.text()
    expect(t1).not.toContain(TOKEN)
    expect(JSON.parse(t1).promijenjeno).toContain('botToken')

    const r2 = await put('telegram', { polja: { botToken: '', prefix: '📣' } })
    expect(r2.status).toBe(200)
    expect((await r2.json() as any).promijenjeno).toEqual(['prefix'])
    const g = await (await fetch(`${p!.url}/api/telegram/config`)).json() as any
    expect(g.stanje.tokenPostavljen).toBe(true)
    expect(g.postavke.prefix).toBe('📣')
    expect(procitaj(g.putanja)).not.toContain(TOKEN) // token seli u spremište vjerodajnica
    expect(JSON.stringify(audit())).not.toContain(TOKEN)
    expect(audit().filter(r => r.key === 'skupina.telegram').length).toBe(2)
  }, 30000)

  test('kartica s vlastitim spremanjem (autonomija): dvije promjene → JEDAN skupina.autonomija redak', async () => {
    const prije = audit().length
    const r = await fetch(`${p!.url}/api/config/autonomy`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionAutonomy: 60, sessionCaution: 80, by: 'vlasnik' }) })
    expect(r.status).toBe(200)
    const novi = audit().slice(prije)
    expect(novi.length).toBe(1)
    expect(novi[0]).toMatchObject({ key: 'skupina.autonomija', changed_by: 'vlasnik', source: 'config-skupina' })
    expect(JSON.parse(novi[0]!.new_value).kljucevi.sort()).toEqual(['sessionAutonomy', 'sessionCaution'])
  }, 30000)

  test('stranica: integracije i telegram imaju jedan „Spremi” po skupini, ne po polju', async () => {
    const html = await (await fetch(`${p!.url}/`)).text()
    expect(html).not.toContain('spremiIntegracijuIzPolja(')
    expect(html).not.toContain("spremiTelegram({chatId:")
    expect(html).not.toContain("spremiDezurni({baseUrl:")
    expect(html).toContain('function skupinaSpremi(')
    expect(html).toContain('beforeunload')
    // skripta stranice živi u predlošku poslužitelja — mora se i dalje parsirati
    const skripte = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]!)
    expect(skripte.length).toBeGreaterThan(0)
    for (const k of skripte) expect(() => new Function(k)).not.toThrow()
  }, 30000)
})
