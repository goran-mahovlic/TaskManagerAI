import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from 'os'

const ISA_DIR = join(process.env.HOME ?? homedir(), "app/regoc_system/ISA");

export interface ISAOptions {
  taskId: string;
  title: string;
  description?: string;
  effort: "E1" | "E2" | "E3" | "E4" | "E5";
  assignee?: string;
}

/**
 * ISA (Ideal State Artifact) Generator for REGOC F4.1.
 *
 * Effort tiers control which sections appear:
 *   E1-E2: Goal + Criteria (minimal)
 *   E3:    + Problem + Test Strategy (4 sections)
 *   E4-E5: all 8 sections
 */
export class ISAGenerator {
  private dir: string;

  constructor(dir: string = ISA_DIR) {
    this.dir = dir;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /** Generate ISA markdown content based on effort tier. */
  generate(options: ISAOptions): string {
    const { taskId, title, description, effort, assignee } = options;
    const effortNum = parseInt(effort[1], 10);

    const lines: string[] = [];
    lines.push(`# ISA: ${taskId} — ${title}`);
    lines.push("");

    if (assignee) {
      lines.push(`**Assignee:** ${assignee}`);
      lines.push(`**Effort:** ${effort}`);
      lines.push("");
    }

    // E3+ sections: Problem
    if (effortNum >= 3) {
      lines.push("## Problem");
      lines.push(description ?? "{What's broken or missing}");
      lines.push("");
    }

    // All tiers: Goal + Criteria
    lines.push("## Goal");
    lines.push("{Desired end state in 1-2 sentences}");
    lines.push("");

    lines.push("## Criteria (ISC — Ideal State Criteria)");
    lines.push("- [ ] Criterion 1");
    lines.push("- [ ] Criterion 2");
    lines.push("- [ ] Criterion 3");
    lines.push("");

    // E4+ sections: Constraints
    if (effortNum >= 4) {
      lines.push("## Constraints");
      lines.push("{Technical, time, or security constraints}");
      lines.push("");
    }

    // E3+ sections: Test Strategy
    if (effortNum >= 3) {
      lines.push("## Test Strategy");
      lines.push("{How to verify the goal is met}");
      lines.push("");
    }

    // E4+ sections: Features, Decisions, Verification
    if (effortNum >= 4) {
      lines.push("## Features");
      lines.push("{Detailed feature breakdown}");
      lines.push("");

      lines.push("## Decisions");
      lines.push("{Key decisions and rationale}");
      lines.push("");

      lines.push("## Verification");
      lines.push("{Filled by agent — evidence that criteria are met}");
      lines.push("");
    }

    return lines.join("\n");
  }

  /** Save ISA to disk and return the file path. */
  save(options: ISAOptions): string {
    const content = this.generate(options);
    const filename = `${options.taskId}.md`;
    const filepath = join(this.dir, filename);
    writeFileSync(filepath, content, "utf-8");
    return filepath;
  }

  /** Load an ISA by task ID. Returns markdown content or null if not found. */
  load(taskId: string): string | null {
    const filepath = join(this.dir, `${taskId}.md`);
    if (!existsSync(filepath)) {
      return null;
    }
    return readFileSync(filepath, "utf-8");
  }

  /** List all ISAs in the directory (excludes _TEMPLATE.md). */
  list(): Array<{ taskId: string; title: string; path: string }> {
    if (!existsSync(this.dir)) return [];

    const files = readdirSync(this.dir).filter(
      (f) => f.endsWith(".md") && f !== "_TEMPLATE.md"
    );

    return files.map((f) => {
      const filepath = join(this.dir, f);
      const content = readFileSync(filepath, "utf-8");
      const taskId = f.replace(/\.md$/, "");

      // Extract title from first heading: "# ISA: TASK-123 — Some Title"
      let title = "";
      const match = content.match(/^# ISA:\s*\S+\s*—\s*(.+)$/m);
      if (match) {
        title = match[1].trim();
      }

      return { taskId, title, path: filepath };
    });
  }

  /** Append verification evidence to an existing ISA. Returns true on success. */
  updateVerification(taskId: string, evidence: string): boolean {
    const filepath = join(this.dir, `${taskId}.md`);
    if (!existsSync(filepath)) {
      return false;
    }

    let content = readFileSync(filepath, "utf-8");

    // If Verification section exists, replace its content
    const verificationRegex = /## Verification\n[\s\S]*?(?=\n## |\n*$)/;
    const verificationSection = `## Verification\n${evidence}`;

    if (content.includes("## Verification")) {
      content = content.replace(verificationRegex, verificationSection);
    } else {
      // Append Verification section at the end
      content = content.trimEnd() + "\n\n" + verificationSection + "\n";
    }

    writeFileSync(filepath, content, "utf-8");
    return true;
  }
}

/** Factory function — returns a singleton-like ISAGenerator instance. */
export function getISAGenerator(): ISAGenerator {
  return new ISAGenerator();
}
