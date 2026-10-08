/**
 * TASK-5371: slanje na zahtjev (POST /api/email/posalji → posaljiEmail s `prima`) smije birati
 * SAMO među upisanim primateljima — ploča nije otvoreni relej. Bez mreže: odbijenica pada prije SMTP-a.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ZADANE_POSTAVKE, posaljiEmail } from '../src/EmailConfig'

let mapa: string, put: string
beforeEach(() => {
  mapa = mkdtempSync(join(tmpdir(), 'tm-email-'))
  put = join(mapa, 'email.json')
  writeFileSync(put, JSON.stringify({
    ...ZADANE_POSTAVKE, ukljucen: true, smjer: 'oba', primatelji: ['vlasnik@primjer.test'],
    smtp: { ...ZADANE_POSTAVKE.smtp, host: 'smtp.primjer.test', korisnik: 'bot', posiljatelj: 'bot@primjer.test', lozinkaEnv: 'TM_TEST_NEMA_LOZINKE_5371' },
  }))
})
afterEach(() => rmSync(mapa, { recursive: true, force: true }))

test('adresa izvan popisa primatelja se odbija prije slanja', async () => {
  const r = await posaljiEmail('Predmet', 'tekst', put, ['stranac@zlo.test'])
  expect(r.ok).toBe(false)
  expect(r.greska).toContain('nije na popisu primatelja')
  expect(r.greska).toContain('stranac@zlo.test')
})

test('adresa s popisa (bez obzira na velika slova) prolazi do koraka lozinke', async () => {
  const r = await posaljiEmail('Predmet', 'tekst', put, ['Vlasnik@Primjer.test'])
  expect(r.ok).toBe(false)
  expect(r.greska).toContain('lozinka nije postavljena')
})
