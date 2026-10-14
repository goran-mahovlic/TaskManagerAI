#!/usr/bin/env bun
/**
 * Privitci jednog (starog) maila na disk — naknadni dohvat (TASK-5508).
 *
 *   bun scripts/posta-privitci.ts <uid> [<uid> …]           # preuzmi u $TM_HOME/privitci/posta/<uid>/
 *   bun scripts/posta-privitci.ts <uid> --bilo-tko          # i pošiljatelj izvan imap.privitci.posiljatelji (samo čovjek)
 *   bun scripts/posta-privitci.ts <uid> --popis             # samo popis privitaka, bez preuzimanja
 *
 * Za mail koji je stigao prije uključenja `imap.privitci` ili čija je obavijest rekla
 * „[PRIVITAK nije spremljen: …]". Postavke i lozinka su iste kao za provjeru pošte na ploči
 * (`email.json`, tajna po `imap.lozinkaEnv`); lozinka se nikad ne ispisuje. Mapa se otvara
 * `readOnly`, dijelovi se čitaju s BODY.PEEK — mail ostaje nepročitan. Ime, mapa, strop
 * veličine, vrste i prava 0600 vrijede kao i za automatski dohvat.
 *
 * Izlaz: 0 sve što je trebalo je na disku · 1 neki privitak nije spremljen · 2 greška/poziv.
 * Ispisuje `[PRIVITAK: /putanja]` po datoteci — isti redak kao u obavijesti.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * Putanje čvora (`TM_HOME`, `TM_CREDENTIALS`, `TM_EMAIL_CONFIG` …) iz `config/postavke.env` uz
 * paket — kao ploča (systemd `EnvironmentFile`). Bez toga CLI pokrenut iz sesije razgovornog
 * bota ne bi našao ni postavke ni lozinku. Samo `TM_*` putanje, nikad tajni retci, i ništa što
 * je već u okolini. Mora prije uvoza paketa: `TM_ROOT` se računa pri učitavanju modula.
 */
function ucitajPutanjeCvora(): void {
  const put = join(import.meta.dir, '..', 'config', 'postavke.env')
  if (!existsSync(put)) return
  for (const redak of readFileSync(put, 'utf-8').split('\n')) {
    const m = /^\s*(?:export\s+)?(TM_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(redak)
    if (!m || /TAJNA|TOKEN|KEY|PASS|SECRET/.test(m[1]!) || m[1]! in process.env) continue
    process.env[m[1]!] = m[2]!.trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}
ucitajPutanjeCvora()

const { loadEmailConfig } = await import('../src/EmailConfig')
const { procitajTajnu } = await import('../src/core/ConfigModul')
const { datotecnoSpremiste, dohvatiPrivitkeZaUid, imapKlijent, opisGreske } = await import('../src/PostaUlaz')
const { oznakePrivitaka } = await import('../src/PostaPrivitci')
type ImapKlijent = import('../src/PostaUlaz').ImapKlijent

const args = process.argv.slice(2)
const uidovi = args.filter(a => /^\d+$/.test(a)).map(Number)
const biloTko = args.includes('--bilo-tko')
const samoPopis = args.includes('--popis')
const nepoznato = args.filter(a => !/^\d+$/.test(a) && !['--bilo-tko', '--popis'].includes(a))

if (!uidovi.length || nepoznato.length || args.includes('-h') || args.includes('--help')) {
  console.error('Uporaba: bun scripts/posta-privitci.ts <uid> [<uid> …] [--bilo-tko] [--popis]')
  process.exit(2)
}

const cfg = loadEmailConfig()
if (!cfg.imap.host || !cfg.imap.korisnik) {
  console.error('✗ IMAP nije postavljen (email.json → imap.host, imap.korisnik)')
  process.exit(2)
}
const lozinka = procitajTajnu(cfg.imap.lozinkaEnv)
if (!lozinka) {
  console.error(`✗ lozinka nije upisana (${cfg.imap.lozinkaEnv}) — ploča: Config → Tajne`)
  process.exit(2)
}

const imap: ImapKlijent = imapKlijent(cfg, lozinka)
let izlaz = 0
for (const uid of uidovi) {
  try {
    if (samoPopis) {
      const ses = await imap.otvori()
      try {
        const m = await ses.poUid?.(uid)
        if (!m) { console.error(`✗ mail ${uid}: nema ga u mapi ${cfg.imap.mapa || 'INBOX'}`); izlaz = Math.max(izlaz, 2); continue }
        console.log(`mail ${uid}: „${m.predmet}" od ${m.od}`)
        for (const d of m.dijelovi || []) console.log(`  dio ${d.dio}  ${d.mime}  ~${Math.round(d.velicina / 1024)} KB  ${d.ime}`)
        if (!m.dijelovi?.length) console.log('  (nema privitaka)')
      } finally { await ses.zatvori() }
      continue
    }
    const r = await dohvatiPrivitkeZaUid({ cfg, imap, spremiste: datotecnoSpremiste(), uid, biloTko })
    if (!r.ok) { console.error(`✗ mail ${uid}: ${r.greska}`); izlaz = Math.max(izlaz, 2); continue }
    console.log(`mail ${uid}: „${r.mail?.predmet}" od ${r.mail?.od}`)
    if (!r.datoteke.length) console.log('  (nema privitaka)')
    for (const o of oznakePrivitaka(r.datoteke)) console.log(`  ${o}`)
    if (r.datoteke.some(d => !d.putanja)) izlaz = Math.max(izlaz, 1)
  } catch (e) {
    console.error(`✗ mail ${uid}: ${opisGreske(e)}`)
    izlaz = Math.max(izlaz, 2)
  }
}
process.exit(izlaz)
