#!/usr/bin/env bun
/**
 * REGOC WikilinkParser (F7.2)
 *
 * Resolves [[wikilink]] references in memory files to actual file paths.
 *
 * Resolution order (putanje iz memory-config.json / env — vidi lib/memory-config.ts):
 *   1. <tier0.memoryDir>/{name}.md      (zadano ~/.claude/projects/<project-slug>/memory)
 *   2. <tier0.lessonsDir>/{name}.md     (zadano ~/app/regoc_system/LESSONS)
 *   3. null (dead link)
 *
 * Usage:
 *   import { getWikilinkParser } from '~/.claude/regoc/WikilinkParser'
 *   const parser = getWikilinkParser()
 *   parser.parse('See [[startup-and-services]] and [[fpga-best-practices]]')
 *   parser.resolveAll('Check [[some-link]]')
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { loadMemoryConfig } from '../skills/CORE/Tools/lib/memory-config'

// ============================================
// Types
// ============================================

export interface ResolvedLink {
  name: string
  path: string | null   // resolved file path, null if dead link
  exists: boolean
}

// ============================================
// Constants
// ============================================

// Tier 0 putanje iz SSOT-a (memory-config.json / env), NE hardkodiran project-slug (TASK-2620)
const MEMORY_DIR = loadMemoryConfig().tier0.memoryDir
const LESSONS_DIR = loadMemoryConfig().tier0.lessonsDir

// Regex to match [[link-name]] — supports alphanumerics, hyphens, underscores, spaces, dots
const WIKILINK_RE = /\[\[([^\[\]]+)\]\]/g

// ============================================
// WikilinkParser
// ============================================

export class WikilinkParser {
  private memoryDir: string
  private lessonsDir: string

  constructor(memoryDir?: string, lessonsDir?: string) {
    this.memoryDir = memoryDir || MEMORY_DIR
    this.lessonsDir = lessonsDir || LESSONS_DIR
  }

  /**
   * Extract all [[name]] references from text content.
   * Returns array of link names (without brackets).
   */
  parse(content: string): string[] {
    const names: string[] = []
    let match: RegExpExecArray | null

    // Reset regex state
    const re = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags)
    while ((match = re.exec(content)) !== null) {
      const name = match[1].trim()
      if (name && !names.includes(name)) {
        names.push(name)
      }
    }

    return names
  }

  /**
   * Resolve a single link name to a file path.
   * Returns the file path if found, null if dead link.
   */
  resolve(name: string): string | null {
    const trimmed = name.trim()

    // 1. Check memory dir
    const memoryPath = join(this.memoryDir, `${trimmed}.md`)
    if (existsSync(memoryPath)) {
      return memoryPath
    }

    // 2. Check LESSONS dir
    const lessonsPath = join(this.lessonsDir, `${trimmed}.md`)
    if (existsSync(lessonsPath)) {
      return lessonsPath
    }

    // 3. Dead link
    return null
  }

  /**
   * Parse all [[links]] from content and resolve each one.
   */
  resolveAll(content: string): ResolvedLink[] {
    const names = this.parse(content)
    return names.map(name => {
      const path = this.resolve(name)
      return {
        name,
        path,
        exists: path !== null,
      }
    })
  }

  /**
   * Find all links in content that do not resolve to any file.
   */
  findDeadLinks(content: string): string[] {
    const names = this.parse(content)
    return names.filter(name => this.resolve(name) === null)
  }
}

// ============================================
// Singleton
// ============================================

let _instance: WikilinkParser | null = null

export function getWikilinkParser(memoryDir?: string, lessonsDir?: string): WikilinkParser {
  if (!_instance || memoryDir || lessonsDir) {
    _instance = new WikilinkParser(memoryDir, lessonsDir)
  }
  return _instance
}
