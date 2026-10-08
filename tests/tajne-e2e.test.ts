// TASK-5343 (ADR-0007) — kraj-do-kraja na pravom poslužitelju ploče.
// Kod hvata lažni Telegram API (TM_TELEGRAM_API). Kanarinac (upisana vrijednost) ne smije biti
// ni u jednom odgovoru API-ja, u dnevniku ploče (stdout/stderr), u auditu, događajima ni u bazi.
// Isto za tajnu zalijepljenu u zadatak (N3: PUT /api/tasks više ne ispisuje tijelo).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'
import { procitajIzTeksta } from '../src/LoginCreds'

const KANARINAC = 'E2eKan4r' + Math.random().toString(36).slice(2) + "$(id)'"
let p: Posluzitelj | null = null
let tg: ReturnType<typeof Bun.serve> | null = null
const poruke: { chat_id: string; text: string }[] = []
const odgovori: string[] = []
let izlaz = ''

const ZAG = { 'Content-Type': 'application/json', 'X-TM-Tajne': '1' }
async function api(metoda: string, put: string, tijelo?: unknown, zag: Record<string, string> = ZAG) {
  const r = await fetch(p!.url + put, { method: metoda, headers: zag, body: tijelo === undefined ? undefined : JSON.stringify(tijelo) })
  const t = await r.text()
  odgovori.push(t)
  let j: any = null; try { j = JSON.parse(t) } catch {}
  return { status: r.status, j, t, cc: r.headers.get('cache-control') }
}
const kod = () => /(\d{8})/.exec(poruke[poruke.length - 1]!.text)![1]!

beforeAll(async () => {
  tg = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.url.endsWith('/sendMessage')) { poruke.push(await req.json() as any); return Response.json({ ok: true }) }
      return Response.json({ ok: true, result: [] })
    },
  })
  p = await podigni({}, { TM_TELEGRAM_API: `http://127.0.0.1:${tg.port}`, TELEGRAM_BOT_TOKEN: '123:lazni' }, {
    izlaz: 'pipe',
    priprema: dom => { mkdirSync(join(dom, 'config'), { recursive: true }); writeFileSync(join(dom, 'config', 'tajne.json'), JSON.stringify({ potvrdaUid: ['555'] })) },
  })
}, 30_000)

afterAll(() => { tg?.stop(true); spusti(p) })

describe('E2E /api/tajne', () => {
  test('upis kroz ploču: kod u privatni chat, vrijednost na disku, nigdje drugdje', async () => {
    const g0 = await api('GET', '/api/tajne')
    expect(g0.status).toBe(200)
    expect(g0.cc).toBe('no-store')
    expect(g0.j.potvrda).toEqual({ podesena: true, primatelja: 1 })
    expect(g0.j.tajne.map((t: any) => t.ime)).toContain('SMTP_PASSWORD')

    const k = await api('POST', '/api/tajne/kod', { imena: ['SMTP_PASSWORD', 'IMAP_PASSWORD'], radnja: 'upis' })
    expect(k.status).toBe(200)
    expect(poruke.length).toBe(1)
    expect(String(poruke[0]!.chat_id)).toBe('555')
    const u = await api('PUT', '/api/tajne', { vrijednosti: { SMTP_PASSWORD: KANARINAC, IMAP_PASSWORD: KANARINAC + '2' }, zahtjevId: k.j.zahtjevId, kod: kod() })
    expect(u.status).toBe(200)

    const spremiste = join(p!.dom, 'config', 'credentials.env')
    expect(procitajIzTeksta(readFileSync(spremiste, 'utf-8'), 'SMTP_PASSWORD')).toBe(KANARINAC)
    expect(statSync(spremiste).mode & 0o777).toBe(0o600)

    // pogrešni pokušaji koji citiraju vrijednost
    await api('PUT', '/api/tajne/SMTP_PASSWORD', { vrijednost: KANARINAC, zahtjevId: 'x', kod: '12345678' })
    await api('PUT', '/api/tajne/BASH_ENV', { vrijednost: KANARINAC })
    const bezZaglavlja = await api('PUT', '/api/tajne/SMTP_PASSWORD', { vrijednost: KANARINAC }, { 'Content-Type': 'application/json' })
    expect(bezZaglavlja.status).toBe(403)

    // N3: tajna zalijepljena u zadatak ne ide u dnevnik
    const nov = await api('POST', '/api/tasks', { title: 'e2e tajne', description: 'x', assignee: 'jelena' })
    const id = nov.j?.task?.id || nov.j?.id
    expect(id).toBeTruthy()
    await api('PUT', `/api/tasks/${id}`, { progressNotes: [`slučajno zalijepljeno ${KANARINAC}`] })

    const g = await api('GET', '/api/tajne')
    const s = g.j.tajne.find((t: any) => t.ime === 'SMTP_PASSWORD')
    expect(s).toMatchObject({ postoji: true, oblik: 'novi' })
    expect(s.zadnje).toMatchObject({ radnja: 'upis', prijenos: 'loopback' })
  }, 30_000)

  test('kanarinac: 0 pogodaka u odgovorima /api/tajne, dnevniku ploče, auditu i događajima', async () => {
    p!.proc.kill()
    await p!.proc.exited
    const out = await new Response(p!.proc.stdout as ReadableStream).text()
    const err = await new Response(p!.proc.stderr as ReadableStream).text()
    izlaz = out + err
    expect(izlaz).toContain('[TAJNE] upis SMTP_PASSWORD ok loopback')
    const tajneOdgovori = odgovori.filter(o => !o.includes('e2e tajne') && !o.includes('slučajno zalijepljeno'))
    for (const t of [izlaz, ...tajneOdgovori]) expect(t).not.toContain(KANARINAC)
    const stanje = join(p!.dom, 'data')
    for (const f of ['tajne_audit.jsonl', 'tajne_dogadaji.jsonl']) {
      const t = readFileSync(join(stanje, f), 'utf-8')
      expect(t).not.toContain(KANARINAC)
      expect(t).not.toContain(KANARINAC.slice(0, 12))
      expect(statSync(join(stanje, f)).mode & 0o777).toBe(0o600)
    }
    // kod iz Telegrama nije ni u auditu ni u dnevniku
    for (const m of poruke) {
      const k = /(\d{8})/.exec(m.text)![1]!
      expect(izlaz).not.toContain(k)
      expect(readFileSync(join(stanje, 'tajne_audit.jsonl'), 'utf-8')).not.toContain(k)
    }
    // nijedna druga datoteka u data/ (baza, dnevnici) ne nosi vrijednost upisanu kroz /api/tajne
    const druga = KANARINAC + '2'
    for (const f of readdirSync(stanje)) {
      const put = join(stanje, f)
      if (statSync(put).isFile()) expect(readFileSync(put).includes(Buffer.from(druga))).toBe(false)
    }
    expect(existsSync(join(p!.dom, 'config', 'credentials.env.lock'))).toBe(false)
  }, 30_000)
})
