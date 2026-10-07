# Vještina System

Vještina System: System maintenance with four core operations - integrity check (find/fix broken references), document session (current transcript), document recent (catch-up since last update), git push (git commit + push). Plus security workflows.
Koristi se kad: integrity check, audit system, document session, document this session, document today, document recent, catch up docs, what's undocumented, git push, commit and push, check for secrets, security scan, privacy check, cross-repo validation, OR asking about past work ("we just worked on", "remember when we").
Status u katalogu alata je kanonski, vlasnik regoc.
Poziva se alatom Skill (`System`) ili čitanjem `~/.claude/skills/System/SKILL.md`.

## Tijekovi vještine
Vještina ima 8 tijekova u mapi Workflows.
- `CrossRepoValidation.md`: Purpose: Validate separation between private PAI instance (~/.claude) and public PAI repository (~/Projects/PAI).
- `DocumentRecent.md`: Purpose: Catch-up documentation for changes since the last documented update.
- `DocumentSession.md`: Purpose: Document the current session's work by analyzing the session transcript.
- `GitPush.md`: Purpose: Git commit and push changes to your PRIVATE PAI repository (~/.claude).
- `IntegrityCheck.md`: Purpose: Find and fix broken references across the PAI system.
- `PrivacyCheck.md`: Purpose: Validate that sensitive data from USER/ and WORK/ directories has not leaked into regular skills, system files, or public-facing content.
- `SecretScanning.md`: Purpose: Scan directories for sensitive information, API keys, tokens, and credentials using TruffleHog.
- `WorkContextRecall.md`: Purpose: When Daniel asks about past work ("we just worked on that", "what did we do with X", "remember when we fixed Y"), this workflow searches across all memory locations to reconstruct context and provide comprehensive recall.
