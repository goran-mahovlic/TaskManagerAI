/**
 * TASK-5378 kraj-do-kraja: pravi poslužitelj ploče, lažni SMTP (broji poruke i primatelje)
 * i lažni Bot API. Ponavlja scenarij s node-A (08.10.): e-pošta uključena, obavijest o
 * zadatku samo za `completed`.
 *   • jedna stvarna promjena u completed = JEDAN mail, samo na upisanog primatelja;
 *   • in_progress i blocked = 0 mailova; ponovljeni PUT (bilješka) = 0 mailova;
 *   • QA proba (oznaka `qa`, ili biljeg `x-regoc-proba: 1`) = 0 mailova i 0 Telegram poruka.
 * Treba `nodemailer` (neobavezna ovisnost) — bez njega se test preskače, ne laže.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'
import { ZADANE_POSTAVKE, imaNodemailer } from '../src/EmailConfig'

const PRIMA = 'sandučić@primjer.test'.replace('č', 'c')
const SAZETAK = 'Izmijenjena datoteka src/x.ts, bun test: 3 pass, 0 fail.\nREGOC-STATUS: DONE — isporučeno'

interface Mail { rcpt: string[]; podaci: string }
const mailovi: Mail[] = []
const telegram: string[] = []
let smtp: ReturnType<typeof Bun.listen> | null = null
let botApi: ReturnType<typeof Bun.serve> | null = null
let p: Posluzitelj | null = null
let cfgDom = ''

/** Najmanji SMTP koji nodemailer prihvaća: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT. */
function lazniSmtp() {
  return Bun.listen<{ buf: string; uPodacima: boolean; mail: Mail }>({
    hostname: '127.0.0.1', port: 0,
    socket: {
      open(s) { s.data = { buf: '', uPodacima: false, mail: { rcpt: [], podaci: '' } }; s.write('220 lazni ESMTP\r\n') },
      data(s, chunk) {
        const st = s.data
        st.buf += chunk.toString()
        while (true) {
          if (st.uPodacima) {
            const kraj = st.buf.indexOf('\r\n.\r\n')
            if (kraj < 0) return
            st.mail.podaci = st.buf.slice(0, kraj)
            st.buf = st.buf.slice(kraj + 5)
            st.uPodacima = false
            mailovi.push(st.mail)
            st.mail = { rcpt: [], podaci: '' }
            s.write('250 primljeno\r\n')
            continue
          }
          const i = st.buf.indexOf('\r\n')
          if (i < 0) return
          const red = st.buf.slice(0, i)
          st.buf = st.buf.slice(i + 2)
          const n = red.toUpperCase()
          if (n.startsWith('EHLO') || n.startsWith('HELO')) s.write('250-lazni\r\n250 AUTH PLAIN\r\n')
          else if (n.startsWith('AUTH PLAIN') && red.trim().split(' ').length > 2) s.write('235 ok\r\n')
          else if (n.startsWith('AUTH PLAIN')) s.write('334 \r\n')
          else if (n.startsWith('MAIL FROM')) s.write('250 ok\r\n')
          else if (n.startsWith('RCPT TO')) { st.mail.rcpt.push(red.replace(/^RCPT TO:\s*<?|>.*$/gi, '')); s.write('250 ok\r\n') }
          else if (n === 'DATA') { st.uPodacima = true; s.write('354 dalje\r\n') }
          else if (n === 'QUIT') { s.write('221 bok\r\n'); s.end() }
          else if (n === 'RSET' || n === 'NOOP') s.write('250 ok\r\n')
          else if (/^[A-Za-z0-9+/=]+$/.test(red)) s.write('235 ok\r\n') // odgovor na 334 (AUTH PLAIN bez početnog)
          else s.write('502 ne znam\r\n')
        }
      },
    },
  })
}

const zahtjev = (metoda: string, put: string, tijelo: object, zaglavlja: Record<string, string> = {}) =>
  fetch(`${p!.url}${put}`, { method: metoda, headers: { 'Content-Type': 'application/json', ...zaglavlja }, body: JSON.stringify(tijelo) })

async function noviZadatak(naslov: string, tags: string[] = []): Promise<string> {
  const r = await zahtjev('POST', '/api/tasks', { title: naslov, description: 'opis zadatka za obavijest', assignee: 'user', priority: 3, tags })
  const t = await r.json() as any
  return t.id || t.task?.id
}

const status = (id: string, s: string, z: Record<string, string> = {}) =>
  zahtjev('PUT', `/api/tasks/${id}`, s === 'completed' ? { status: s, resultSummary: SAZETAK } : { status: s, ...(s === 'blocked' ? { blockedReason: 'čeka' } : {}) }, z)

/** Slanje ne čeka PUT — kratka stanka da SMTP razgovor završi. */
const pricekaj = () => Bun.sleep(700)

describe.skipIf(!imaNodemailer())('obavijest o zadatku e-poštom na ploči', () => {
  beforeAll(async () => {
    smtp = lazniSmtp()
    botApi = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname.endsWith('/sendMessage')) telegram.push(String(((await req.json()) as any).text || ''))
        return Response.json({ ok: true, result: {} })
      },
    })
    cfgDom = mkdtempSync(join(tmpdir(), 'tm-obav-ploca-'))
    const email = join(cfgDom, 'email.json')
    writeFileSync(email, JSON.stringify({
      ...ZADANE_POSTAVKE, ukljucen: true, smjer: 'izlaz', primatelji: [PRIMA],
      smtp: { host: '127.0.0.1', port: smtp.port, tls: false, korisnik: 'bot', lozinkaEnv: 'TM_TEST_SMTP_5378', posiljatelj: 'bot@primjer.test' },
      obavijestZadatak: { ukljucena: true, statusi: ['completed'], najviseNaSat: 10 },
    }))
    const tg = join(cfgDom, 'telegram.json')
    writeFileSync(tg, JSON.stringify({ ukljucen: true, chatId: '-100123', obavijestZavrseno: true, obavijestGreska: true }))
    p = await podigni({}, {
      TM_EMAIL_CONFIG: email, TM_TEST_SMTP_5378: 'lozinka-za-test',
      TM_TELEGRAM_CONFIG: tg, TM_TELEGRAM_API: `http://127.0.0.1:${botApi.port}`, TELEGRAM_BOT_TOKEN: 'test-token',
    })
  }, 30_000)

  afterAll(() => {
    spusti(p)
    smtp?.stop(true)
    botApi?.stop(true)
    if (cfgDom) rmSync(cfgDom, { recursive: true, force: true })
  })

  test('in_progress = 0 mailova; completed = 1 mail na upisanog primatelja; ponovni PUT = 0', async () => {
    const id = await noviZadatak('stvarni zadatak za obavijest')
    expect((await status(id, 'in_progress')).status).toBe(200)
    await pricekaj()
    expect(mailovi.length).toBe(0)

    expect((await status(id, 'completed')).status).toBe(200)
    await pricekaj()
    expect(mailovi.length).toBe(1)
    expect(mailovi[0].rcpt).toEqual([PRIMA])
    expect(mailovi[0].podaci).toContain(id)

    expect((await zahtjev('PUT', `/api/tasks/${id}`, { status: 'completed', resultSummary: SAZETAK })).status).toBe(200)
    await pricekaj()
    expect(mailovi.length).toBe(1)
  }, 20_000)

  test('blocked nije odabran = 0 mailova', async () => {
    const prije = mailovi.length
    const id = await noviZadatak('zadatak koji zapne')
    await status(id, 'in_progress')
    expect((await status(id, 'blocked')).status).toBe(200)
    await pricekaj()
    expect(mailovi.length).toBe(prije)
  }, 20_000)

  test('QA proba (oznaka qa / biljeg x-regoc-proba) = 0 mailova i 0 Telegram poruka', async () => {
    const mPrije = mailovi.length
    const tPrije = telegram.length
    expect(tPrije).toBeGreaterThan(0) // lažni Bot API radi: stvarni completed iz prvog testa je stigao
    const a = await noviZadatak('QA proba — samo odgovori OK', ['qa', 'qa-5312'])
    await status(a, 'in_progress')
    expect((await status(a, 'completed')).status).toBe(200)
    const b = await noviZadatak('obični naslov, ali probni PUT')
    await status(b, 'in_progress')
    expect((await status(b, 'completed', { 'x-regoc-proba': '1' })).status).toBe(200)
    await pricekaj()
    expect(mailovi.length).toBe(mPrije)
    expect(telegram.length).toBe(tPrije)
  }, 20_000)

  test('kartica E-pošta: in_progress se ne može spremiti (400, ništa zapisano), completed+blocked može', async () => {
    const los = await zahtjev('PUT', '/api/config/skupina/email', { polja: { obavijestZadatak: { statusi: ['completed', 'in_progress'] } }, by: 'test' })
    expect(los.status).toBe(400)
    const d = await (await fetch(`${p!.url}/api/email/config`)).json() as any
    const post = d.postavke || d.config || d
    expect(post.obavijestZadatak.statusi).toEqual(['completed'])
    // shema ide preko žice s dopuštenim vrijednostima — kartica iz nje crta kvačice
    const sh = JSON.stringify(d.shema || d)
    expect(sh).toContain('cancelled')
    const dobar = await zahtjev('PUT', '/api/config/skupina/email', { polja: { obavijestZadatak: { statusi: ['completed', 'blocked'] } }, by: 'test' })
    expect(dobar.status).toBe(200)
    const d2 = await (await fetch(`${p!.url}/api/email/config`)).json() as any
    expect((d2.postavke || d2.config || d2).obavijestZadatak.statusi).toEqual(['completed', 'blocked'])
  }, 20_000)
})
