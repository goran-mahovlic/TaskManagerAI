// TASK-5343 (ADR-0007 §4.2) — potvrda vlasnika: kod od 8 znamenki u privatni Telegram.
// J8 jednokratnost, istek, 5 pokušaja, 10/15 min → zaključano; J9 primatelji.
import { describe, expect, test } from 'bun:test'
import { PotvrdaVlasnika } from '../src/core/PotvrdaVlasnika'

function okolina(uid: string[] = ['111']) {
  let sad = 1_000_000
  const poslano: { uid: string; tekst: string }[] = []
  const p = new PotvrdaVlasnika({
    sat: () => sad,
    primatelji: () => uid,
    posalji: async (u, t) => { poslano.push({ uid: u, tekst: t }); return true },
    cvor: 'node-T',
  })
  const kodIz = (i = poslano.length - 1) => /(\d{8})/.exec(poslano[i]!.tekst)![1]!
  return { p, poslano, kodIz, pomakni: (ms: number) => { sad += ms } }
}

describe('PotvrdaVlasnika', () => {
  test('kod ide samo primateljima iz potvrdaUid, vrijedi jednom', async () => {
    const o = okolina(['111', '222'])
    const z = await o.p.zatrazi('SMTP_PASSWORD', 'upis')
    expect(z.ok).toBe(true)
    if (!z.ok) return
    expect(z.poslanoNa).toBe(2)
    expect(o.poslano.map(x => x.uid)).toEqual(['111', '222'])
    expect(o.poslano[0]!.tekst).toContain('SMTP_PASSWORD')
    expect(o.poslano[0]!.tekst).toContain('node-T')
    const kod = o.kodIz()
    expect(JSON.stringify(z)).not.toContain(kod)
    expect(o.p.provjeri(z.zahtjevId, kod, 'SMTP_PASSWORD', 'upis')).toEqual({ ok: true })
    expect(o.p.provjeri(z.zahtjevId, kod, 'SMTP_PASSWORD', 'upis')).toMatchObject({ ok: false, greska: 'zahtjev_nevazeci' })
  })

  test('bez potvrdaUid → potvrda_nije_podesena, ništa se ne šalje', async () => {
    const o = okolina([])
    expect(await o.p.zatrazi('SMTP_PASSWORD', 'upis')).toMatchObject({ ok: false, greska: 'potvrda_nije_podesena' })
    expect(o.poslano.length).toBe(0)
  })

  test('kod je vezan uz ime i radnju', async () => {
    const o = okolina()
    const z = await o.p.zatrazi('SMTP_PASSWORD', 'upis') as any
    expect(o.p.provjeri(z.zahtjevId, o.kodIz(), 'IMAP_PASSWORD', 'upis')).toMatchObject({ ok: false })
    const z2 = await o.p.zatrazi('SMTP_PASSWORD', 'upis') as any
    expect(o.p.provjeri(z2.zahtjevId, o.kodIz(), 'SMTP_PASSWORD', 'brisanje')).toMatchObject({ ok: false })
  })

  test('istek nakon 5 min', async () => {
    const o = okolina()
    const z = await o.p.zatrazi('SMTP_PASSWORD', 'upis') as any
    o.pomakni(5 * 60_000 + 1)
    expect(o.p.provjeri(z.zahtjevId, o.kodIz(), 'SMTP_PASSWORD', 'upis')).toMatchObject({ ok: false, greska: 'zahtjev_nevazeci' })
  })

  test('5 pogrešnih → zahtjev mrtav i točan kod više ne vrijedi', async () => {
    const o = okolina()
    const z = await o.p.zatrazi('SMTP_PASSWORD', 'upis') as any
    const kod = o.kodIz()
    const krivi = kod === '00000000' ? '11111111' : '00000000'
    for (let i = 0; i < 5; i++) expect(o.p.provjeri(z.zahtjevId, krivi, 'SMTP_PASSWORD', 'upis')).toMatchObject({ ok: false, greska: 'kod_pogresan' })
    expect(o.p.provjeri(z.zahtjevId, kod, 'SMTP_PASSWORD', 'upis')).toMatchObject({ ok: false, greska: 'zahtjev_nevazeci' })
  })

  test('10 pogrešnih u 15 min → zaključano (429) 15 min', async () => {
    const o = okolina()
    for (let n = 0; n < 2; n++) {
      const z = await o.p.zatrazi('SMTP_PASSWORD', 'upis') as any
      for (let i = 0; i < 5; i++) o.p.provjeri(z.zahtjevId, 'x', 'SMTP_PASSWORD', 'upis')
    }
    const prije = o.poslano.length
    expect(await o.p.zatrazi('SMTP_PASSWORD', 'upis')).toMatchObject({ ok: false, greska: 'zakljucano' })
    expect(o.poslano.length).toBe(prije)
    o.pomakni(15 * 60_000 + 1)
    expect((await o.p.zatrazi('SMTP_PASSWORD', 'upis')).ok).toBe(true)
  })

  test('slanje nije uspjelo nikome → greška, zahtjev ne ostaje', async () => {
    const p = new PotvrdaVlasnika({ sat: () => 1, primatelji: () => ['1'], posalji: async () => false, cvor: 'x' })
    expect(await p.zatrazi('SMTP_PASSWORD', 'upis')).toMatchObject({ ok: false, greska: 'slanje_nije_uspjelo' })
  })

  test('kod je 8 znamenki iz kriptografskog izvora', async () => {
    const o = okolina()
    const kodovi = new Set<string>()
    for (let i = 0; i < 20; i++) { await o.p.zatrazi('SMTP_PASSWORD', 'upis'); kodovi.add(o.kodIz()) }
    for (const k of kodovi) expect(k).toMatch(/^\d{8}$/)
    expect(kodovi.size).toBeGreaterThan(15)
  })
})

describe('TASK-5346 / uputa #198: opis neuspjelog slanja', () => {
  test('pošiljatelj može vratiti {ok:false, opis} — opis ide u ishod, kod se ne pamti', async () => {
    const p = new PotvrdaVlasnika({ sat: () => 1, primatelji: () => ['1'], posalji: async () => ({ ok: false, opis: 'Forbidden: bot was blocked by the user' }), cvor: 'x' })
    expect(await p.zatrazi('SMTP_PASSWORD', 'upis')).toEqual({ ok: false, greska: 'slanje_nije_uspjelo', opis: 'Forbidden: bot was blocked by the user' })
  })
  test('{ok:true} vrijedi kao poslano', async () => {
    const p = new PotvrdaVlasnika({ sat: () => 1, primatelji: () => ['1'], posalji: async () => ({ ok: true }), cvor: 'x' })
    expect((await p.zatrazi('SMTP_PASSWORD', 'upis')).ok).toBe(true)
  })
})
