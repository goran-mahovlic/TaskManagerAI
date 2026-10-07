# Vještina CORE

Vještina CORE: Personal AI Infrastructure core. AUTO-LOADS at session start. The authoritative reference for how the PAI system works, how to use it, and all system-level configuration.
Koristi se kad: any session begins, user asks about the system, identity, configuration, workflows, security, or any other question about how the PAI system operates.
Status u katalogu alata je kanonski, vlasnik regoc.
Poziva se alatom Skill (`CORE`) ili čitanjem `~/.claude/skills/CORE/SKILL.md`.

## Tijekovi vještine
Vještina ima 4 tijekova u mapi Workflows.
- `Delegation.md`: Comprehensive guide to delegating tasks to agents in the hybrid agent system.
- `ImageProcessing.md`: Background removal, background addition, and image optimization utilities.
- `SessionContinuity.md`: Purpose: Maintain structured continuity artifacts for multi-session work based on Anthropic's agent harness patterns.
<!-- uvjet-redak: glas --> - `Transcription.md`: Extract transcripts from audio and video files using local faster-whisper or OpenAI Whisper API.
