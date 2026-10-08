// TASK-5349 — ispit TASK-5341: odgovara li Šaban (node-A) iz banke cvor_node_a na pitanja o slanju
// datoteke i audiju (savjet/send-doc, savjet/glas, savjet/bot-kanal).
//
// Vrti ISPORUČENI kod na node-A (~/TaskManagerAI/src) sa ŽIVIM postavkama razgovora (memorija, banka,
// url, model), pravim izvršiteljem `claude -p`, pravim Hindsightom, agentima i uputama čvora.
// Kanal je lažan (bilježi, NE šalje u grupu — bez buke u grupi node-A). Trag razgovora ide na PRAVU
// ploču node-A kroz njezin HTTP API (sinkroni curl, jer je sučelje PlocaRazgovora sinkrono), pa je
// bilješka „💬 odgovor (… · 🧠 N činjenica …)" vidljiva na ploči kao u živom razgovoru (TASK-5337).
// Svako pitanje je zaseban chat (zasebna sesija) — odgovor ne nasljeđuje prethodni.
//
// Upotreba (na node-A): TM_DB=… bun pitaj_sabana.ts <izlazna-mapa>
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
const HOME = process.env.HOME!
const SRC = HOME + '/TaskManagerAI/src'
const { stvoriRazgovor } = await import(SRC + '/razgovor/Razgovor')
const { izvrsiteljRazgovora } = await import(SRC + '/razgovor/Izvrsitelj')
const { createRazgovorReader } = await import(SRC + '/razgovor/RazgovorPostavke')
const { modelPrebacen, modelIzKonfiguracije, ciljModelaRazgovora } = await import(SRC + '/razgovor/RazgovorPloca')
const { ucitajAgente, ucitajUpute } = await import(SRC + '/razgovor/Identitet')
const { stvoriZadatkeRazgovora } = await import(SRC + '/razgovor/ZadatakRazgovora')
const { loadMemoryConfig } = await import(SRC + '/rag/memory-config')

const IZLAZ = process.argv[2] || HOME + '/app/tmp/TASK-5349'
const K = IZLAZ + '/razgovor'
rmSync(K, { recursive: true, force: true }); mkdirSync(K, { recursive: true })
const MC = process.env.TM_MODEL_CONFIG || HOME + '/.claude/regoc/models/model-config.json'
const PLOCA = 'http://127.0.0.1:17781'

// Sinkroni HTTP prema ploči node-A (curl), jer PlocaRazgovora ne smije biti async.
const http = (metoda: string, put: string, tijelo?: any): any => {
  const a = ['-s', '-X', metoda, PLOCA + put, '-H', 'Content-Type: application/json']
  if (tijelo !== undefined) a.push('-d', JSON.stringify(tijelo))
  const r = spawnSync('curl', a, { encoding: 'utf-8', timeout: 15000 })
  try { return JSON.parse(r.stdout) } catch { return { _sirovo: r.stdout } }
}
const zadatak = (j: any) => j?.task ?? j
const ploca = {
  stvori: (o: any) => zadatak(http('POST', '/api/tasks', { title: o.naslov.slice(0, 200), description: o.opis, tags: o.oznake, createdBy: o.autor, priority: 3 }))?.id ?? null,
  status: (id: string) => zadatak(http('GET', '/api/tasks/' + id))?.status ?? null,
  postaviStatus: (id: string, status: string, rezultat?: string) => !!zadatak(http('PUT', '/api/tasks/' + id, { status, ...(rezultat ? { resultSummary: rezultat } : {}) }))?.id,
  biljeska: (id: string, _autor: string, tekst: string) => { http('PUT', '/api/tasks/' + id, { progressNotes: [tekst] }) },
}
const zivo = createRazgovorReader({ dbPath: process.env.TM_DB! })().postavke
console.log('postavke:', JSON.stringify({ ime: zivo.ime, memorija: zivo.memorijaRazgovor, banka: zivo.memorijaBanka, url: zivo.memorijaUrl, ovlasti: zivo.ovlasti }))
// Samo za probu: mention-način, kratki burst, bez preskakanja. Memorija, banka, model, ovlasti — ŽIVI.
const post = () => ({ ...zivo, ukljucen: true, odgovaraNa: 'spomen', burstMs: 200, preskociAkoSadrzi: [] as string[] })
const zadaci = stvoriZadatkeRazgovora({ ploca, korijen: K, autor: () => zivo.ime || 'bot', pragMs: 0, log: (s: string) => console.log('  ZR', s) })
const izv = izvrsiteljRazgovora()
const orig = izv.run.bind(izv)
let prompt = ''
izv.run = async (r: any) => { prompt = r.prompt; return orig(r) }
const konzola: string[] = []
const r = stvoriRazgovor({
  postavke: post, izvrsitelj: izv, jePauza: () => false, kvotaPuna: () => false,
  modelZadano: () => modelIzKonfiguracije(MC), modelPrebacen: () => modelPrebacen(MC), ciljModela: (s: any) => ciljModelaRazgovora(MC, s),
  agenti: () => ucitajAgente(process.env.TM_AGENTS_REGISTRY), upute: () => ucitajUpute(process.env.TM_RAZGOVOR_UPUTE),
  korijen: K, tmHome: HOME + '/TaskManagerAI', home: HOME, port: 17781, plocaUrl: PLOCA,
  instalacija: 'node-A (QA TASK-5349)', env: { ...process.env },
  ragUkljucen: () => { try { return loadMemoryConfig().rag.enabled } catch { return null } },
  zadaci, konzola: (s: string) => { konzola.push(s) }, log: (s: string) => console.log('  LOG', s),
} as any)

const PITANJA = [
  'Kako se šalje datoteka u grupu?',
  'Što ako ti slanje datoteke javi „putanja nije apsolutna"? A što ako oznaku napišeš s okruglim (( )) zagradama?',
  'Odakle ti token za slanje datoteke u grupu?',
  'Kako napraviti audio izvještaj? I što ako glas javi „nema venva"?',
]
const ishod: any[] = []
for (const [i, q] of PITANJA.entries()) {
  const poslano: string[] = []
  const kanal = { ime: 'telegram', maxDuljinaPoruke: 4096, maxDokumentBajta: 50e6,
    async posaljiTekst(_c: string, t: string) { poslano.push(t); return true },
    async posaljiDokument(_c: string, p: string) { poslano.push('DOK ' + p); return true } }
  prompt = ''; konzola.length = 0
  const chatId = '-5349' + i
  r.primi({ kanal: 'telegram', chatId, porukaId: String(100 + i), posiljateljId: '777000111', posiljateljIme: 'Potjeh (QA)',
    posiljateljKorisnickoIme: 'x_regoc_qa', posiljateljJeBot: false, tekst: `@${zivo.ime} ${q}`,
    ts: new Date().toISOString(), privatno: false, obracanjeBotu: true } as any, kanal as any)
  await Bun.sleep(400); await r.mirno()
  const blok = (prompt.match(/\[MEMORIJA[\s\S]*?\[\/MEMORIJA\]/) || [''])[0]
  const zadatakId = konzola.map(s => s.match(/zadatak razgovora (TASK-\d+)/)?.[1]).find(Boolean) ?? null
  ishod.push({ pitanje: q, chatId, zadatakId, odgovor: poslano.join('\n'), konzola: [...konzola], memorijskiBlok: blok })
  console.log(`\n=== P${i + 1}: ${q}\n--- zadatak: ${zadatakId}\n--- konzola:\n${konzola.join('\n')}\n--- ODGOVOR:\n${poslano.join('\n')}`)
}
writeFileSync(IZLAZ + '/ishod.json', JSON.stringify(ishod, null, 2))
process.exit(0)
