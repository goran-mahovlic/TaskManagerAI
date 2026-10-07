# Vještina CreateSkill

Vještina CreateSkill: Create and validate skills.
Koristi se kad: create skill, new skill, skill structure, canonicalize, package skill. SkillSearch('createskill') for docs.
Status u katalogu alata je zastario, vlasnik regoc.
Nije dodijeljena nijednom agentu u registru.
Poziva se alatom Skill (`CreateSkill`) ili čitanjem `~/.claude/skills/CreateSkill/SKILL.md`.

## Tijekovi vještine
Vještina ima 4 tijekova u mapi Workflows.
- `CanonicalizeSkill.md`: Purpose: Restructure an existing skill to match the canonical format with proper naming conventions.
- `CreateSkill.md`: Create a new skill following the canonical structure with proper TitleCase naming.
- `UpdateSkill.md`: Purpose: Add workflows or modify an existing skill while maintaining canonical structure and TitleCase naming.
- `ValidateSkill.md`: Purpose: Check if an existing skill follows the canonical structure with proper TitleCase naming.
