# Agenti sustava REGOČ

## Kako agenti postoje
Registar `REGOC_AGENTS.json` sadrži imenovane agente i Kritičara. Agent nije trajni proces. Kad zadatak u TaskManageru ima `assignee`, RegocDaemon pokreće novi proces `claude --print` s punim identitetom agenta (spawn na zahtjev). Identitet gradi `${SUSTAV_DIR}/IdentityBlock.ts` iz registra i šalje ga na sistemski kanal: ime, ulogu, stil, vlastite vještine, putanje znanja i RAG memoriju. `AgentFactory`, `UnifiedSpawnPipeline` i `AgentWorker` su napušteni i ne pozivaju se. Samo Klaudio radi trajno (kao Telegram bot). Ostali agenti u tablici `agent_status` imaju stare otkucaje, što je normalno za spawn na zahtjev.

<!--u:rag-->Svaki agent ima vlastitu RAG kolekciju `agent_<id>` (npr.<!--/u--> <!--u:rag-->`agent_kosjenka`).<!--/u--> Kako se u nju upisuje, opisano je u `tijekovi-rada.md` (odjeljak RAG).

## Popis agenata
<!--u:rag-->Puni identitet svakog agenta (opis, osobnost i komunikacijski stil, model, vlastite vještine i alati, putanje znanja, RAG kolekcija i mjesto u tijekovima) nalazi se u generiranoj datoteci `popis/agent-<id>.md`.<!--/u--> Ondje su i vrijednosti koje se mijenjaju (model, popis vještina i alata), pa se ovdje ne ponavljaju. Ovdje stoji samo ono što registar ne zna.

REGOČ (`regoc`) je meta-orkestrator. Ne izvršava posao nego ga raspodjeljuje.

Klaudio (`klaudio`) je Telegram agent koji radi 24/7 i komunicira tekstom i glasom.

Stribor (`stribor`) je prema registru stručnjak za analizu glasa i govora. Stariji dokumenti ga opisuju kao TeamSpeak agenta na sonnetu, što je zastarjelo.

Kosjenka Vuković (`kosjenka`) je arhitektica: arhitektura sustava, ADR-ovi, planovi i dokumentacija.

Jelena Kovačević (`jelena`) je inženjerka: precizna implementacija u TypeScriptu i Pythonu, TDD i dijagnostika pogrešaka. Kad Jelena dokaže testove i dokumentaciju, njezin rad ne treba dodatnu provjeru preko REGOČ-a.

Malik Hodžić (`malik`) je sigurnosni stručnjak: penetracijsko testiranje i sigurnosni pregledi.

Manda Perić (`manda`) je istraživačica: RAG, dokumentacija, strateška analiza.

Dora Matić (`dora`) je analitičarka više perspektiva.

Gita Horvat (`gita`) je umjetnica za generativnu umjetnost i vizualizacije. Gita i Grga od 03.10.2026. smiju znati putanje, IP adrese i portove; sigurnosna izolacija je ukinuta. Za vjerodajnice vrijedi opće pravilo: samo ime varijable, nikad vrijednost.

Grga Babić (`grga`) je dizajner sučelja (UI/UX).

Potjeh Novak (`potjeh`) je QA i pripravnik: testiranje i rutinski posao. Postoji i lokalni sparring `${SUSTAV_DIR}/tools/consult-potjeh.ts`, koji koristi lokalni model.

Kritičar (`kriticar`) je neovisni provjeravatelj nalaza i dokumenata. Nema vlastiti posao, zadatak ni RAG upis; vraća sud pozivatelju (vratar zatvaranja zadataka). Ne spawna se kao radni agent.

## Lanac rada (teamChain)
Za složen zadatak razine E4 `ModeClassifier.ts` predlaže lanac Kosjenka → Jelena → Potjeh → Malik (dizajn → implementacija → test → sigurnost). Kad zahtjev traži istraživanje, lanac je Manda → Kosjenka → Jelena → Potjeh. Lanac uključuju zastavice `teamChain` i `teamChainLive`. Kanal-agenti (Klaudio, Stribor) nikad nisu u lancu. Usporedni rad ograničava strop iz postavke `agents.max_concurrent` (trenutačna vrijednost je u `popis/prekidaci.md`), a lanac i dalje ide serijski.

## Modeli
Model u registru je zadana vrijednost. Stvarni model može nadjačati `model-config.json` (`agentOverrides`) preko ModelRoutera; model se ne smije hardkodirati.
