#!/usr/bin/env bun
/**
 * REGOC AgentLogger (A4) — Unified Agent Logging
 *
 * One JSONL log file per agent spawn that captures everything:
 * spawn context, work output, tool calls, signals, messages, completion/errors.
 *
 * Storage: ~/.claude/regoc/logs/agents/
 *   - {agentId}_{taskId}_{YYYYMMDD_HHmmss}.jsonl
 *
 * Log rotation: keeps last 100 session files, deletes oldest.
 *
 * Usage:
 *   import { getAgentLogger } from '~/.claude/regoc/AgentLogger'
 *   const logger = getAgentLogger()
 *   const logPath = logger.startSession('jelena', 'TASK-430', 'Implement JWT auth...')
 *   logger.log('jelena', 'TASK-430', 'WORK', 'Reading simulator.py...')
 *   logger.log('jelena', 'TASK-430', 'TOOL', 'Bash: bun test', { tool: 'Bash', duration_ms: 1500 })
 *   logger.log('jelena', 'TASK-430', 'COMPLETE', '[TASK_DONE:TASK-430] 15/15 tests pass')
 *
 * @version 1.0.0
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "fs";
import { join, basename } from "path";

// ============================================
// Types
// ============================================

export type LogPhase =
  | "SPAWN"
  | "WORK"
  | "TOOL"
  | "SIGNAL"
  | "MESSAGE"
  | "COMPLETE"
  | "ERROR";

export interface AgentLogEntry {
  ts: string; // ISO timestamp
  agent: string;
  taskId: string;
  phase: LogPhase;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SessionInfo {
  agentId: string;
  taskId: string;
  logPath: string;
  startedAt: string;
  lineCount: number;
}

export interface SessionSummary {
  agentId: string;
  taskId: string;
  startedAt: string;
  completedAt: string | null;
  totalEntries: number;
  byPhase: Record<string, number>;
  lastEntry: AgentLogEntry | null;
}

// ============================================
// Constants
// ============================================

const DEFAULT_LOG_DIR = join(
  process.env.HOME || "",
  ".claude/regoc/logs/agents"
);
const MAX_SESSIONS = 100;
const LOG_FILE_REGEX =
  /^([a-z0-9_-]+)_(TASK-\d+)_(\d{8}_\d{6})\.jsonl$/;

// ============================================
// AgentLogger
// ============================================

export class AgentLogger {
  private logDir: string;
  // Map of "agentId:taskId" -> log file path for active sessions
  private activeSessions: Map<string, string> = new Map();

  constructor(logDir?: string) {
    this.logDir = logDir || DEFAULT_LOG_DIR;
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  // --- Public API ---

  /**
   * Start logging for a new agent spawn. Creates the JSONL file and writes
   * the initial SPAWN entry.
   * @returns The absolute path to the log file.
   */
  startSession(agentId: string, taskId: string, prompt: string): string {
    const now = new Date();
    const timestamp = this.formatTimestamp(now);
    const filename = `${agentId}_${taskId}_${timestamp}.jsonl`;
    const logPath = join(this.logDir, filename);

    const key = this.sessionKey(agentId, taskId);
    this.activeSessions.set(key, logPath);

    // Write initial SPAWN entry
    const entry: AgentLogEntry = {
      ts: now.toISOString(),
      agent: agentId,
      taskId,
      phase: "SPAWN",
      content: `Spawning agent ${agentId} for ${taskId}`,
      metadata: {
        prompt_length: prompt.length,
        prompt_preview: prompt.slice(0, 200),
      },
    };
    appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");

    // Rotate old sessions
    this.rotateIfNeeded();

    return logPath;
  }

  /**
   * Log an entry to the agent's session file.
   */
  log(
    agentId: string,
    taskId: string,
    phase: LogPhase,
    content: string,
    metadata?: Record<string, unknown>
  ): void {
    const logPath = this.resolveLogPath(agentId, taskId);
    if (!logPath) {
      // No active session — start one implicitly
      this.startSession(agentId, taskId, "(implicit session)");
      this.log(agentId, taskId, phase, content, metadata);
      return;
    }

    const entry: AgentLogEntry = {
      ts: new Date().toISOString(),
      agent: agentId,
      taskId,
      phase,
      content,
    };
    if (metadata && Object.keys(metadata).length > 0) {
      entry.metadata = metadata;
    }
    appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  /**
   * Capture stdout/stderr from a Bun subprocess into the log.
   * Reads stdout/stderr line by line and writes each as a WORK entry.
   */
  captureOutput(
    agentId: string,
    taskId: string,
    proc: {
      stdout: ReadableStream | null;
      stderr: ReadableStream | null;
    }
  ): void {
    if (proc.stdout) {
      this.streamToLog(agentId, taskId, proc.stdout, "stdout");
    }
    if (proc.stderr) {
      this.streamToLog(agentId, taskId, proc.stderr, "stderr");
    }
  }

  /**
   * Read log entries from a session file.
   * @param logPath Absolute path to the .jsonl file
   * @param options Filter by phase and/or limit results
   */
  readLog(
    logPath: string,
    options?: { phase?: LogPhase; limit?: number }
  ): AgentLogEntry[] {
    if (!existsSync(logPath)) return [];

    const content = readFileSync(logPath, "utf-8").trim();
    if (!content) return [];

    let entries: AgentLogEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AgentLogEntry;
        if (options?.phase && entry.phase !== options.phase) continue;
        entries.push(entry);
      } catch {
        // skip malformed lines
      }
    }

    if (options?.limit && options.limit > 0) {
      entries = entries.slice(-options.limit);
    }

    return entries;
  }

  /**
   * List all agent sessions, most recent first.
   * @param options Filter by agentId and/or limit results
   */
  listSessions(options?: {
    agentId?: string;
    limit?: number;
  }): SessionInfo[] {
    if (!existsSync(this.logDir)) return [];

    const files = readdirSync(this.logDir).filter((f) =>
      f.endsWith(".jsonl")
    );

    let sessions: SessionInfo[] = [];
    for (const file of files) {
      const match = file.match(LOG_FILE_REGEX);
      if (!match) continue;

      const [, agentId, taskId, timestampStr] = match;
      if (options?.agentId && agentId !== options.agentId) continue;

      const filePath = join(this.logDir, file);
      const content = readFileSync(filePath, "utf-8").trim();
      const lineCount = content ? content.split("\n").length : 0;

      // Parse timestamp from filename: YYYYMMDD_HHmmss
      const startedAt = this.parseTimestamp(timestampStr);

      sessions.push({
        agentId,
        taskId,
        logPath: filePath,
        startedAt,
        lineCount,
      });
    }

    // Sort by startedAt descending (most recent first)
    sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    if (options?.limit && options.limit > 0) {
      sessions = sessions.slice(0, options.limit);
    }

    return sessions;
  }

  /**
   * Get summary for a session.
   */
  getSessionSummary(logPath: string): SessionSummary {
    const entries = this.readLog(logPath);

    const byPhase: Record<string, number> = {};
    let startedAt = "";
    let completedAt: string | null = null;
    let agentId = "";
    let taskId = "";

    for (const entry of entries) {
      byPhase[entry.phase] = (byPhase[entry.phase] || 0) + 1;

      if (!agentId) agentId = entry.agent;
      if (!taskId) taskId = entry.taskId;

      if (entry.phase === "SPAWN" && !startedAt) {
        startedAt = entry.ts;
      }
      if (entry.phase === "COMPLETE" || entry.phase === "ERROR") {
        completedAt = entry.ts;
      }
    }

    return {
      agentId,
      taskId,
      startedAt,
      completedAt,
      totalEntries: entries.length,
      byPhase,
      lastEntry: entries.length > 0 ? entries[entries.length - 1] : null,
    };
  }

  // --- Internal ---

  private sessionKey(agentId: string, taskId: string): string {
    return `${agentId}:${taskId}`;
  }

  private resolveLogPath(agentId: string, taskId: string): string | null {
    const key = this.sessionKey(agentId, taskId);
    const path = this.activeSessions.get(key);
    if (path && existsSync(path)) return path;

    // Fallback: find the most recent file matching agentId + taskId
    if (!existsSync(this.logDir)) return null;
    const files = readdirSync(this.logDir)
      .filter((f) => f.startsWith(`${agentId}_${taskId}_`) && f.endsWith(".jsonl"))
      .sort()
      .reverse();

    if (files.length > 0) {
      const resolved = join(this.logDir, files[0]);
      this.activeSessions.set(key, resolved);
      return resolved;
    }

    return null;
  }

  private formatTimestamp(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const h = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    const s = String(date.getSeconds()).padStart(2, "0");
    return `${y}${m}${d}_${h}${min}${s}`;
  }

  private parseTimestamp(ts: string): string {
    // YYYYMMDD_HHmmss -> ISO string
    const year = ts.slice(0, 4);
    const month = ts.slice(4, 6);
    const day = ts.slice(6, 8);
    const hour = ts.slice(9, 11);
    const minute = ts.slice(11, 13);
    const second = ts.slice(13, 15);
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  }

  private async streamToLog(
    agentId: string,
    taskId: string,
    stream: ReadableStream,
    source: "stdout" | "stderr"
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split("\n");
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          this.log(agentId, taskId, "WORK", line, { source });
        }
      }

      // Flush remaining buffer
      if (buffer.trim()) {
        this.log(agentId, taskId, "WORK", buffer, { source });
      }
    } catch (err) {
      this.log(agentId, taskId, "ERROR", `Stream read error (${source}): ${err}`, {
        source,
      });
    }
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.logDir)) return;

    const files = readdirSync(this.logDir)
      .filter((f) => f.endsWith(".jsonl") && LOG_FILE_REGEX.test(f))
      .sort(); // Ascending by name (which includes timestamp)

    if (files.length <= MAX_SESSIONS) return;

    // Delete oldest files
    const toDelete = files.slice(0, files.length - MAX_SESSIONS);
    for (const file of toDelete) {
      try {
        unlinkSync(join(this.logDir, file));
      } catch {
        // ignore deletion errors
      }
    }
  }
}

// ============================================
// Singleton
// ============================================

let _instance: AgentLogger | null = null;

export function getAgentLogger(logDir?: string): AgentLogger {
  if (!_instance || logDir) {
    _instance = new AgentLogger(logDir);
  }
  return _instance;
}
