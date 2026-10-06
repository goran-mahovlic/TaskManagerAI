// TASK-5300 — zna li Šaban koju memoriju ima. Vrti ISPORUČENI kod na node-A (~/TaskManagerAI/src)
// sa ŽIVIM postavkama razgovora (memorija on, banka, url), pravim izvršiteljem claude i pravim
// Hindsightom. Kanal je lažan (bilježi, NE šalje u grupu); korijen sesija je zaseban.
import { mkdirSync, rmSync } from 'fs'
const SRC = process.env.HOME + '/TaskManagerAI/src'
const { stvoriRazgovor } = await import(SRC + '/razgovor/Razgovor')
const { izvrsiteljRazgovora } = await import(SRC + '/razgovor/Izvrsitelj')
const { createRazgovorReader } = await import(SRC + '/razgovor/RazgovorPostavke')
const { loadMemoryConfig } = await import(SRC + '/rag/memory-config')

const HOME = process.env.HOME!
const K = HOME + '/app/tmp/task5300/proba'
rmSync(K, { recursive: true, force: true }); mkdirSync(K, { recursive: true })
const zivo = createRazgovorReader({ dbPath: process.env.TM_DB! })().postavke
const post = () => ({ ...zivo, ukljucen: true, odgovaraNa: 'spomen', burstMs: 200, preskociAkoSadrzi: [] as string[] })
console.log('postavke:', JSON.stringify({ ime: zivo.ime, memorija: zivo.memorijaRazgovor, banka: zivo.memorijaBanka, url: zivo.memorijaUrl, ovlasti: zivo.ovlasti }))
const izv = izvrsiteljRazgovora()
const orig = izv.run.bind(izv)
let sp = ''; let prompt = ''
izv.run = async (r: any) => { sp = r.systemPrompt || ''; prompt = r.prompt; return orig(r) }
const r = stvoriRazgovor({
  postavke: post, izvrsitelj: izv, jePauza: () => false, kvotaPuna: () => false,
  korijen: K + '/razgovor', tmHome: HOME + '/TaskManagerAI', home: HOME, port: 17781, plocaUrl: 'http://127.0.0.1:17781',
  instalacija: 'node-A (proba TASK-5300)', env: { ...process.env },
  ragUkljucen: () => loadMemoryConfig().rag.enabled,
  log: (s: string) => console.log('  LOG', s),
})
const poslano: string[] = []
const kanal = { ime: 'telegram', maxDuljinaPoruke: 4096, maxDokumentBajta: 50e6,
  async posaljiTekst(_c: string, t: string) { poslano.push(t); return true },
  async posaljiDokument(_c: string, p: string) { poslano.push('DOK ' + p); return true } }
r.primi({ kanal: 'telegram', chatId: '-5112799687', porukaId: '1', posiljateljId: '777000111', posiljateljIme: 'Proba',
  posiljateljKorisnickoIme: 'x_regoc_proba', posiljateljJeBot: false, tekst: `@${zivo.ime} imaš li pristup memoriji i kojoj?`,
  ts: new Date().toISOString(), privatno: false, obracanjeBotu: true } as any, kanal as any)
await Bun.sleep(400); await r.mirno()
const odg = poslano.join('\n')
console.log('--- odjeljak identiteta:\n' + (sp.split('\n').filter(l => /memorij|RAG|Hindsight|Banka|Datotečn/i.test(l)).join('\n')))
console.log('--- zaglavlje bloka u promptu:', (prompt.match(/\[MEMORIJA[^\]]*\]/) || ['(nema bloka)'])[0])
console.log('--- ODGOVOR:\n' + odg)
const prov: [string, boolean][] = [
  ['spominje banku regoc_opus_nodea', odg.includes('regoc_opus_nodea')],
  ['spominje Hindsight', /hindsight/i.test(odg)],
  ['kaže da RAG-a nema', /RAG[^\n]{0,60}(isključ|nema|ne koristi|bez)|bez RAG/i.test(odg)],
  ['ne prisvaja 206 datoteka / MEMORY.md glavnog čvora', !/206/.test(odg) && !/imam[^\n]{0,40}datotečn/i.test(odg)],
]
for (const [n, ok] of prov) console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`)
console.log(`UKUPNO ${prov.filter(p => p[1]).length}/${prov.length}`)
