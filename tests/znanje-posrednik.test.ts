/**
 * ADR-0006 §8 opcija B, mjerilo Z6: posrednik pred Hindsightom propušta SAMO banku čvora.
 */
import { describe, expect, test } from 'bun:test'
import { createPosrednik, odluci } from '../src/znanje/Posrednik'

const CILJ = 'http://hs.test'

function lazniHindsight() {
  const pozivi: Array<{ metoda: string; url: string }> = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    pozivi.push({ metoda: init?.method || 'GET', url })
    if (url === `${CILJ}/v1/default/banks`) {
      return Response.json({ banks: [{ bank_id: 'nasa_glavna' }, { bank_id: 'banka_cvora' }, { bank_id: 'arhiva' }] })
    }
    return Response.json({ ok: true, url })
  }) as unknown as typeof fetch
  return { pozivi, fetchImpl }
}

const zahtjev = (metoda: string, put: string, tijelo?: unknown) =>
  new Request(`http://posrednik${put}`, { method: metoda, body: tijelo ? JSON.stringify(tijelo) : undefined, headers: { 'Content-Type': 'application/json' } })

describe('odluci (čisto pravilo)', () => {
  const B = ['banka_cvora']
  test.each([
    ['GET', '/health', 'propusti'],
    ['GET', '/v1/default/banks', 'popis'],
    ['POST', '/v1/default/banks/banka_cvora/memories/recall', 'propusti'],
    ['POST', '/v1/default/banks/banka_cvora/memories', 'llm'],
    ['POST', '/v1/default/banks/banka_cvora/reflect', 'llm'],
    ['GET', '/v1/default/banks/banka_cvora/memories/list', 'propusti'],
    ['GET', '/v1/default/banks/banka_cvora/documents', 'propusti'],
    ['POST', '/v1/default/banks/banka_cvora/webhooks', 'zabrani'],
    ['POST', '/v1/default/banks/banka_cvora/clone', 'zabrani'],
    ['PATCH', '/v1/default/banks/banka_cvora/config', 'zabrani'],
    ['POST', '/v1/default/banks/banka_cvora/transfer/import', 'zabrani'],
    ['DELETE', '/v1/default/banks/banka_cvora/memories', 'zabrani'],
    ['GET', '/v1/default/banks/banka_cvora/documents/a%2F..%2F..%2Fnasa_glavna', 'zabrani'],
    ['GET', '/v1/default/banks/banka_cvora/documents/a%5Cb', 'zabrani'],
    ['GET', '/v1/default/banks/banka_cvora/memories%2Frecall', 'zabrani'],
    ['DELETE', '/v1/default/banks/banka_cvora/documents/sustav%2Fagenti', 'propusti'],
    ['PUT', '/v1/default/banks/banka_cvora', 'propusti'],
    ['DELETE', '/v1/default/banks/banka_cvora', 'zabrani'],
    ['POST', '/v1/default/banks/nasa_glavna/memories/recall', 'zabrani'],
    ['GET', '/v1/default/banks/nasa_glavna/documents', 'zabrani'],
    ['DELETE', '/v1/default/banks/nasa_glavna/documents/x', 'zabrani'],
    ['GET', '/v1/default/banks/banka_cvora%2F..%2Fnasa_glavna/memories', 'zabrani'],
    ['GET', '/v1/drugi/banks/banka_cvora/memories', 'zabrani'],
    ['GET', '/docs', 'zabrani'],
  ])('%s %s → %s', (m, p, ocek) => {
    expect(odluci(m, p, B).vrsta).toBe(ocek)
  })
})

describe('Z6 — posrednik', () => {
  test('dopuštena banka 200, prosljeđuje se na cilj', async () => {
    const h = lazniHindsight()
    const p = createPosrednik({ cilj: CILJ, banke: ['banka_cvora'], fetchImpl: h.fetchImpl })
    const r = await p(zahtjev('POST', '/v1/default/banks/banka_cvora/memories/recall', { query: 'x' }))
    expect(r.status).toBe(200)
    expect(h.pozivi.at(-1)!.url).toBe(`${CILJ}/v1/default/banks/banka_cvora/memories/recall`)
  })

  test('tuđa banka 403 i NIJEDAN poziv prema Hindsightu', async () => {
    const h = lazniHindsight()
    const p = createPosrednik({ cilj: CILJ, banke: ['banka_cvora'], fetchImpl: h.fetchImpl })
    for (const [m, put] of [['POST', '/v1/default/banks/nasa_glavna/memories/recall'], ['DELETE', '/v1/default/banks/arhiva'], ['DELETE', '/v1/default/banks/banka_cvora']]) {
      expect((await p(zahtjev(m, put))).status).toBe(403)
    }
    expect(h.pozivi.length).toBe(0)
  })

  test('popis banaka = samo dopuštena', async () => {
    const h = lazniHindsight()
    const p = createPosrednik({ cilj: CILJ, banke: ['banka_cvora'], fetchImpl: h.fetchImpl })
    const j: any = await (await p(zahtjev('GET', '/v1/default/banks'))).json()
    expect(j.banks.map((b: any) => b.bank_id)).toEqual(['banka_cvora'])
  })

  test('prosljeđuje kanonski URL: id dokumenta ponovo kodiran, upit sačuvan', async () => {
    const h = lazniHindsight()
    const p = createPosrednik({ cilj: CILJ, banke: ['banka_cvora'], fetchImpl: h.fetchImpl })
    expect((await p(zahtjev('DELETE', '/v1/default/banks/banka_cvora/documents/sustav%2Fagenti?x=1'))).status).toBe(200)
    expect(h.pozivi.at(-1)!.url).toBe(`${CILJ}/v1/default/banks/banka_cvora/documents/sustav%2Fagenti?x=1`)
  })

  test('PUT banke prosljeđuje samo dopuštena polja; upit samo uz GET', async () => {
    let tijelo = ''
    let zadnji = ''
    const fetchImpl = (async (url: string, init?: RequestInit) => { zadnji = url; tijelo = String(init?.body ?? ''); return Response.json({}) }) as unknown as typeof fetch
    const p = createPosrednik({ cilj: CILJ, banke: ['banka_cvora'], fetchImpl })
    await p(zahtjev('PUT', '/v1/default/banks/banka_cvora?x=1', { name: 'n', mission: 'm', retain_chunk_size: 99999, retain_custom_instructions: 'x' }))
    expect(JSON.parse(tijelo)).toEqual({ name: 'n', mission: 'm' })
    expect(zadnji).toBe(`${CILJ}/v1/default/banks/banka_cvora`)
  })

  test('reflect uz zatvorena vrata → 429', async () => {
    const h = lazniHindsight()
    const p = createPosrednik({ cilj: CILJ, banke: ['banka_cvora'], fetchImpl: h.fetchImpl, vrata: async () => ({ smije: false, razlog: 'tjedan' }) })
    expect((await p(zahtjev('POST', '/v1/default/banks/banka_cvora/reflect', { query: 'x' }))).status).toBe(429)
    expect(h.pozivi.length).toBe(0)
  })

  test('retain uz zatvorena vrata kvote → 429 s razlogom, bez poziva', async () => {
    const h = lazniHindsight()
    const p = createPosrednik({ cilj: CILJ, banke: ['banka_cvora'], fetchImpl: h.fetchImpl, vrata: async () => ({ smije: false, razlog: 'sesija 90 %' }) })
    const r = await p(zahtjev('POST', '/v1/default/banks/banka_cvora/memories', { items: [] }))
    expect(r.status).toBe(429)
    expect(((await r.json()) as any).razlog).toContain('sesija')
    expect(h.pozivi.length).toBe(0)
  })

  test('retain uz otvorena vrata drži bravu za vrijeme poziva', async () => {
    const h = lazniHindsight()
    const dogadaji: string[] = []
    const p = createPosrednik({
      cilj: CILJ, banke: ['banka_cvora'], fetchImpl: h.fetchImpl,
      vrata: async () => ({ smije: true }),
      brava: { uzmi: () => dogadaji.push('uzmi'), pusti: () => dogadaji.push('pusti') },
    })
    expect((await p(zahtjev('POST', '/v1/default/banks/banka_cvora/memories', { items: [] }))).status).toBe(200)
    expect(dogadaji).toEqual(['uzmi', 'pusti'])
  })
})
