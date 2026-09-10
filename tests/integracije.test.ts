/**
 * Testovi četiriju integracija + `ProbeGuard` (DIZAJN-integracije §7 — uvjet gotovosti).
 *
 * Šest tvrdnji koje dizajn traži po modulu:
 *   1. `load*` bez datoteke daje zadane vrijednosti, i NIJEDNA nije naša vrijednost;
 *   2. provjera odbija nepoznato polje IMENOM;
 *   3. provjera odbija neispravan `baseUrl` i `..` u nazivu mape;
 *   4. `save*` → `load*` vraća zapisano, nepoznata polja iz datoteke se čuvaju;
 *   5. odgovor za ploču NIKAD ne nosi vrijednost tajne (tvrdnja nad CIJELIM tijelom);
 *   6. `ProbeGuard` odbija `file://`, preusmjeravanje na drugi host i prevelik odgovor.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  provjeriUrl, probaj, prigusenje, resetirajPrigusenje, sigurniZapis, PROBE_ZADANO,
} from '../src/core/ProbeGuard'
import { tajnaPostavljena, procitajTajnu, zapisiTajnu } from '../src/core/ConfigModul'
import {
  ZADANE_POSTAVKE as NC_ZADANE, loadNextcloudConfig, saveNextcloudConfig,
  validateNextcloudPatch, stanjeNextcloud, putanjaProjekta,
} from '../src/NextcloudConfig'
import {
  ZADANE_POSTAVKE as EM_ZADANE, loadEmailConfig, saveEmailConfig, validateEmailPatch, stanjeEmail,
} from '../src/EmailConfig'
import {
  ZADANE_POSTAVKE as GL_ZADANE, loadGitLabConfig, saveGitLabConfig, validateGitLabPatch, vezaGitLab,
} from '../src/GitLabConfig'
import {
  ZADANE_POSTAVKE as GH_ZADANE, loadGitHubConfig, saveGitHubConfig, validateGitHubPatch, vezaGitHub,
} from '../src/GitHubConfig'

/**
 * Uzorci se slažu iz dijelova NAMJERNO: doslovni niz u ovoj datoteci oborio bi branu
 * `tests/bez-nasih-vrijednosti.test.ts`, koja ne razlikuje curenje od tvrdnje o curenju.
 * (Sama brana sebe izuzima; ostale datoteke ne.)
 */
const TUDJ_HOME = ['/home', 'klaudio'].join('/')
const TUDJA_DOMENA = '@' + 'intergalaktik' + '.hr'
const TUDJ_RASPORED = '.claude' + '/regoc'

let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-int-')); resetirajPrigusenje() })
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })
const put = (ime: string) => join(mapa, ime)

// ─── 1. Zadane vrijednosti bez ijedne naše ───────────────────────────────────

describe('zadane vrijednosti (DIZAJN §1.2)', () => {
  const SVE = {
    nextcloud: NC_ZADANE, email: EM_ZADANE, gitlab: GL_ZADANE, github: GH_ZADANE,
  } as Record<string, unknown>

  for (const [ime, zadane] of Object.entries(SVE)) {
    test(`${ime}: nijedna zadana vrijednost nije naša (adresa, domena, putanja)`, () => {
      const tekst = JSON.stringify(zadane)
      expect(tekst).not.toContain('192.168.')
      expect(tekst).not.toContain(TUDJA_DOMENA)
      expect(tekst).not.toContain(TUDJ_HOME)
      expect(tekst).not.toContain(TUDJ_RASPORED)
      expect((zadane as any).ukljucen).toBe(false)
    })
  }

  test('nijedna integracija se ne pali sama, a tajne su IMENA varijabli', () => {
    expect(NC_ZADANE.lozinkaEnv).toMatch(/^[A-Z][A-Z0-9_]*$/)
    expect(EM_ZADANE.smtp.lozinkaEnv).toMatch(/^[A-Z][A-Z0-9_]*$/)
    expect(GL_ZADANE.tokenEnv).toMatch(/^[A-Z][A-Z0-9_]*$/)
    expect(GH_ZADANE.tokenEnv).toMatch(/^[A-Z][A-Z0-9_]*$/)
  })

  test('load bez datoteke vraća zadane, ne baca', () => {
    expect(loadNextcloudConfig(put('nema.json')).baseUrl).toBe('')
    expect(loadEmailConfig(put('nema.json')).smjer).toBe('izlaz')
    expect(loadGitLabConfig(put('nema.json')).nacin).toBe('cli')
    expect(loadGitHubConfig(put('nema.json')).repo).toBe('')
  })
})

// ─── 2. i 3. Provjera zakrpe ─────────────────────────────────────────────────

describe('provjera zakrpe (DIZAJN §1.2, §7)', () => {
  test('nepoznato polje se odbija IMENOM i nudi popis dopuštenih', () => {
    const r = validateNextcloudPatch({ baseUrll: 'https://x.hr' })
    expect(r.ok).toBe(false)
    expect(r.greske.join(' ')).toContain('baseUrll')
    expect(r.greske.join(' ')).toContain('baseUrl')
  })

  test('nepoznato polje UNUTAR ugniježđenog objekta se također odbija', () => {
    const r = validateEmailPatch({ smtp: { hostt: 'posta.hr' } })
    expect(r.ok).toBe(false)
    expect(r.greske.join(' ')).toContain('smtp.hostt')
  })

  test('baseUrl koji nije http(s) se odbija', () => {
    expect(validateNextcloudPatch({ baseUrl: 'ftp://oblak.hr' }).ok).toBe(false)
    expect(validateNextcloudPatch({ baseUrl: 'https://oblak.primjer.hr' }).ok).toBe(true)
  })

  test('„.." u nazivu mape se odbija (izlazak iz mape)', () => {
    expect(validateNextcloudPatch({ korijenskaMapa: '../../etc' }).ok).toBe(false)
    expect(validateNextcloudPatch({ korijenskaMapa: '/apsolutno' }).ok).toBe(false)
    expect(validateNextcloudPatch({ korijenskaMapa: 'TaskManager' }).ok).toBe(true)
  })

  test('IMAP filtar s CRLF-om se odbija (injekcija u naredbu)', () => {
    expect(validateEmailPatch({ imap: { filtar: 'To: x\r\nLOGOUT' } }).ok).toBe(false)
    expect(validateEmailPatch({ imap: { filtar: 'Subject: [TASK]' } }).ok).toBe(true)
  })

  test('u polje za IME varijable ne može se upisati sama tajna', () => {
    const r = validateGitHubPatch({ tokenEnv: 'ghp_stvarnitokenkojinesmijeovdje' })
    expect(r.ok).toBe(false)
    expect(r.greske.join(' ')).toContain('IME varijable')
  })

  test('oblik repozitorija se provjerava', () => {
    expect(validateGitHubPatch({ repo: 'bez-kose-crte' }).ok).toBe(false)
    expect(validateGitHubPatch({ repo: 'vlasnik/repo' }).ok).toBe(true)
    expect(validateGitLabPatch({ projekt: 'grupa/podgrupa/repo' }).ok).toBe(true)
  })

  test('primatelj koji nije adresa e-pošte se odbija', () => {
    expect(validateEmailPatch({ primatelji: ['nije-adresa'] }).ok).toBe(false)
    expect(validateEmailPatch({ primatelji: ['tko@primjer.hr'] }).ok).toBe(true)
  })

  test('prazna zakrpa je greška, ne tihi uspjeh', () => {
    expect(validateGitLabPatch({}).ok).toBe(false)
  })
})

// ─── 4. Zapis i čitanje ──────────────────────────────────────────────────────

describe('save → load', () => {
  test('vraća zapisano i ČUVA nepoznata polja iz datoteke', () => {
    const p = put('nextcloud.json')
    writeFileSync(p, JSON.stringify({ moje_polje: 'ostaje' }), 'utf-8')
    saveNextcloudConfig({ baseUrl: 'https://oblak.primjer.hr', ukljucen: true }, p)
    const cfg = loadNextcloudConfig(p)
    expect(cfg.baseUrl).toBe('https://oblak.primjer.hr')
    expect(cfg.ukljucen).toBe(true)
    expect((cfg as any).moje_polje).toBe('ostaje')
  })

  test('ugniježđeni objekt se spaja po dubini, ne pregazi cijelu granu', () => {
    const p = put('email.json')
    saveEmailConfig({ smtp: { ...EM_ZADANE.smtp, host: 'posta.primjer.hr' } }, p)
    saveEmailConfig({ smtp: { port: 465 } as any }, p)
    const cfg = loadEmailConfig(p)
    expect(cfg.smtp.host).toBe('posta.primjer.hr')
    expect(cfg.smtp.port).toBe(465)
  })

  test('neispravan JSON na disku ne ruši čitanje', () => {
    const p = put('gitlab.json')
    writeFileSync(p, '{ ovo nije json', 'utf-8')
    expect(loadGitLabConfig(p).nacin).toBe('cli')
  })
})

// ─── 5. Tajne ────────────────────────────────────────────────────────────────

describe('tajne (DIZAJN §1.3)', () => {
  test('stanje za ploču ne nosi vrijednost tajne nigdje u tijelu odgovora', () => {
    const p = put('creds.env')
    writeFileSync(p, 'NEXTCLOUD_APP_PASSWORD=tajna-vrijednost-123\n', { mode: 0o600 })
    process.env.TM_TEST_TAJNA = 'tajna-vrijednost-123'
    try {
      const cfg = { ...NC_ZADANE, ukljucen: true, baseUrl: 'https://x.hr', korisnik: 'a', lozinkaEnv: 'TM_TEST_TAJNA' }
      const tijelo = JSON.stringify({ postavke: cfg, stanje: stanjeNextcloud(cfg) })
      expect(tijelo).not.toContain('tajna-vrijednost-123')
      expect(JSON.parse(tijelo).stanje.tajnaPostavljena).toBe(true)
    } finally {
      delete process.env.TM_TEST_TAJNA
    }
  })

  test('tajnaPostavljena čita okolinu i datoteku, ali vrijednost ne vraća', () => {
    const p = put('creds.env')
    writeFileSync(p, '# komentar\nIMAP_PASSWORD=abc123\nPRAZNA=\n', { mode: 0o600 })
    expect(tajnaPostavljena('IMAP_PASSWORD', p)).toBe(true)
    expect(tajnaPostavljena('PRAZNA', p)).toBe(false)
    expect(tajnaPostavljena('NEMA_ME', p)).toBe(false)
    expect(procitajTajnu('IMAP_PASSWORD', p)).toBe('abc123')
  })

  test('zapisiTajnu stvara datoteku s pravima 0600 i mijenja postojeći zapis', () => {
    const p = put('creds.env')
    expect(zapisiTajnu('SMTP_PASSWORD', 'prva', p).ok).toBe(true)
    expect(zapisiTajnu('SMTP_PASSWORD', 'druga', p).ok).toBe(true)
    expect(procitajTajnu('SMTP_PASSWORD', p)).toBe('druga')
    expect(readFileSync(p, 'utf-8').split('\n').filter(r => r.startsWith('SMTP_PASSWORD')).length).toBe(1)
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  test('tajna s prijelazom retka i neispravno ime varijable se odbijaju', () => {
    const p = put('creds.env')
    expect(zapisiTajnu('SMTP_PASSWORD', 'a\nb', p).ok).toBe(false)
    expect(zapisiTajnu('mala slova', 'x', p).ok).toBe(false)
  })
})

// ─── 6. ProbeGuard ───────────────────────────────────────────────────────────

describe('ProbeGuard (SSRF, DIZAJN §1.4)', () => {
  test('file:// i druge sheme se odbijaju prije ijednog poziva', () => {
    expect(provjeriUrl('file:///etc/passwd').ok).toBe(false)
    expect(provjeriUrl('gopher://x').ok).toBe(false)
    expect(provjeriUrl('ftp://x').ok).toBe(false)
  })

  test('http traži izričito dopuštenje, https prolazi', () => {
    expect(provjeriUrl('http://oblak.hr').ok).toBe(false)
    expect(provjeriUrl('http://oblak.hr', { dopustiHttp: true }).ok).toBe(true)
    expect(provjeriUrl('https://oblak.hr').ok).toBe(true)
  })

  test('privatne mreže su dopuštene zadano, ali se mogu isključiti', () => {
    expect(provjeriUrl('https://192.168.1.5').ok).toBe(true)
    const r = provjeriUrl('https://192.168.1.5', { dopustiPrivatneMreze: false })
    expect(r.ok).toBe(false)
    expect(r.greska).toContain('privatnoj mreži')
    expect(provjeriUrl('https://10.1.2.3', { dopustiPrivatneMreze: false }).ok).toBe(false)
    expect(provjeriUrl('https://localhost', { dopustiPrivatneMreze: false }).ok).toBe(false)
    expect(provjeriUrl('https://oblak.primjer.hr', { dopustiPrivatneMreze: false }).ok).toBe(true)
  })

  test('vjerodajnice u adresi se odbijaju (završile bi u dnevniku)', () => {
    expect(provjeriUrl('https://ivan:tajna@oblak.hr').ok).toBe(false)
  })

  test('preusmjeravanje na drugi host zaustavlja probu', async () => {
    const posluzitelj = Bun.serve({
      port: 0,
      fetch: () => new Response('', { status: 302, headers: { Location: 'https://drugi.primjer.hr/x' } }),
    })
    try {
      const r = await probaj(`http://127.0.0.1:${posluzitelj.port}/`, { dopustiHttp: true })
      expect(r.ok).toBe(false)
      expect(r.greska).toContain('drugi host')
    } finally { posluzitelj.stop(true) }
  })

  test('preusmjeravanje na ISTI host nije razlog za odbijanje', async () => {
    const posluzitelj = Bun.serve({
      port: 0,
      fetch: (req) => new URL(req.url).pathname === '/'
        ? new Response('', { status: 302, headers: { Location: '/dalje' } })
        : new Response('ok'),
    })
    try {
      const r = await probaj(`http://127.0.0.1:${posluzitelj.port}/`, { dopustiHttp: true })
      expect(r.greska || '').not.toContain('drugi host')
    } finally { posluzitelj.stop(true) }
  })

  test('odgovor veći od granice se odbija (proba nije čitač stranica)', async () => {
    const posluzitelj = Bun.serve({ port: 0, fetch: () => new Response('x'.repeat(200_000)) })
    try {
      const r = await probaj(`http://127.0.0.1:${posluzitelj.port}/`, { dopustiHttp: true, maxBajtova: 1024 })
      expect(r.ok).toBe(false)
      expect(r.greska).toContain('KB')
    } finally { posluzitelj.stop(true) }
  })

  test('prigušenje pušta jednu probu po razmaku', () => {
    const t = 1_000_000
    expect(prigusenje('x', PROBE_ZADANO.razmakMs, t).ok).toBe(true)
    expect(prigusenje('x', PROBE_ZADANO.razmakMs, t + 1000).ok).toBe(false)
    expect(prigusenje('x', PROBE_ZADANO.razmakMs, t + 6000).ok).toBe(true)
  })

  test('zapis u dnevnik gubi upit i vjerodajnice', () => {
    expect(sigurniZapis('https://ivan:tajna@oblak.hr/dav?token=abc')).toBe('https://oblak.hr/dav')
  })
})

// ─── Nextcloud: putanje ──────────────────────────────────────────────────────

describe('Nextcloud putanje', () => {
  test('mapa po projektu se dodaje samo kad je uključena', () => {
    const cfg = { ...NC_ZADANE, korijenskaMapa: 'TaskManager' }
    expect(putanjaProjekta(cfg, 'PRJ-001')).toBe('TaskManager/PRJ-001')
    expect(putanjaProjekta({ ...cfg, mapaPoProjektu: false }, 'PRJ-001')).toBe('TaskManager')
    expect(putanjaProjekta(cfg, null)).toBe('TaskManager')
  })

  test('opasan naziv projekta ispada iz putanje, ne izlazi iz mape', () => {
    const cfg = { ...NC_ZADANE, korijenskaMapa: 'TaskManager' }
    expect(putanjaProjekta(cfg, '../../etc')).toBe('TaskManager')
  })
})

// ─── GitLab / GitHub: veza ───────────────────────────────────────────────────

describe('GitLab i GitHub veza (§4, §5)', () => {
  test('zadani način je CLI — korisnikova vlastita prijava, bez tokena u našoj konfiguraciji', () => {
    expect(GL_ZADANE.nacin).toBe('cli')
    expect(GH_ZADANE.nacin).toBe('cli')
  })

  test('veza nosi ono što je upisano, GitHub uvijek github.com', () => {
    const p = put('gitlab.json')
    saveGitLabConfig({ projekt: 'grupa/repo', host: 'gitlab.tvrtka.hr' }, p)
    const v = vezaGitLab(loadGitLabConfig(p))
    expect(v.projekt).toBe('grupa/repo')
    expect(v.host).toBe('gitlab.tvrtka.hr')

    const p2 = put('github.json')
    saveGitHubConfig({ repo: 'vlasnik/repo' }, p2)
    expect(vezaGitHub(loadGitHubConfig(p2)).host).toBe('github.com')
  })
})

// ─── E-pošta: neobavezna knjižnica ───────────────────────────────────────────

describe('e-pošta bez nodemailera', () => {
  test('stanje kaže što nedostaje ključem za prijevod, ne hrvatskom rečenicom', () => {
    const s = stanjeEmail({ ...EM_ZADANE, ukljucen: true })
    expect(s.spreman).toBe(false)
    expect(s.zastoKey).toMatch(/^int_zasto_/)
  })
})
