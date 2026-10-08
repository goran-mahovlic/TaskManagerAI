// TASK-5349 točka 3 — Šaban (node-A) pita Klaudija preko kanala bot↔bot (ADR-0003), kao kad zapne.
// Vrti ISPORUČENI kod na node-A (~/TaskManagerAI/src): žive postavke kanala iz baze ploče, tajna
// slanja iz okoline procesa ploče (/proc/<pid>/environ, nikad se ne ispisuje), isto spremište
// (strop/brojilo vrijede). Poruka ide samo LAN-om s HMAC potpisom; Klaudijev odgovor ide u grupu
// i pokreće upis savjeta u banku cvor_node_a (TASK-5341, ZnanjeCvoru.ts).
// Pokretanje (na node-A): bun pitaj_klaudija.ts <pid ploče> "<pitanje bez @>"
import { readFileSync } from 'fs'
const SRC = process.env.HOME + '/TaskManagerAI/src'
const { stvoriBotKanal } = await import(SRC + '/razgovor/BotKanal')
const { createBotKanalReader, spremisteUBazi } = await import(SRC + '/razgovor/BotKanalPostavke')

const [pid, pitanje] = process.argv.slice(2)
if (!pid || !pitanje) { console.error('uporaba: bun pitaj_klaudija.ts <pid ploče> "<pitanje>"'); process.exit(2) }
const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf-8').split('\0').filter(Boolean)
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const db = env.TM_DB
const postavke = createBotKanalReader(db)
const p = postavke()
console.log('kanal:', JSON.stringify({ ukljucen: p.ukljucen, chatovi: p.chatovi, strop: p.strop,
  drugi: p.drugi.map((x: any) => ({ ime: x.ime, korisnickoIme: x.korisnickoIme, url: x.url })) }))
const klaudio = p.drugi.find((x: any) => /klaudio/i.test(x.ime))
if (!klaudio) { console.error('nema Klaudija u postavkama kanala'); process.exit(3) }
const bk = stvoriBotKanal({
  ja: 'saban', postavke,
  tajnaSlanja: () => env.TM_BOT_KANAL_TAJNA_SLANJE,
  tajnaPrimanja: () => env.TM_BOT_KANAL_TAJNA_PRIMANJE,
  spremiste: spremisteUBazi(db),
  zadaniStopKorisnici: () => [],
  javiUGrupu: async (_c: string, t: string) => { console.log('  JAVI (ne šalje se):', t) },
  naStop: () => {},
  log: (s: string) => console.log('  LOG', s),
})
const tekst = `@${klaudio.korisnickoIme} ${pitanje}`
const r = await bk.prenesi({ chatId: p.chatovi[0], tekst, telegramPorukaId: null,
  izvornik: { id: 'qa-task-5349', ime: 'Potjeh (QA TASK-5349)' } })
console.log('poslano u', new Date().toISOString(), '→', r)
console.log('tekst:', tekst)
