#!/usr/bin/env bun
/**
 * REGOČ Create Project Workflow
 *
 * Automatizovani workflow za kreiranje projekta sa Nextcloud integracijom.
 *
 * Funkcionalnost:
 * 1. Kreira Nextcloud folder u /PROJEKTI/{projectName}/
 * 2. Dijeli folder sa korisnicima (default: goran)
 * 3. Kreira projekt u TaskManager-u
 * 4. Linkuje nextcloud_folder_id i share_url u projekt metadata
 * 5. Vraća projekt objekt
 *
 * Author: Kosjenka Horvat (Architect Agent)
 * Version: 1.0.0
 * Created: 2026-02-22
 */

import { getProjectManager } from '../ProjectManager'
import type { CreateProjectInput, Project } from '../zod/schemas/project'
import { homedir } from 'os'
import { join } from 'path'
import { procitajTajnuSpremista } from '../lib/spremiste-tajni'

// ============================================
// CONFIGURATION
// ============================================

interface NextcloudConfig {
  url: string
  user: string
  password: string
}

interface CreateProjectWorkflowOptions {
  name: string
  description?: string
  shareWith?: string | string[]
  priority?: number
  lead_agent?: string
  tags?: string[]
}

interface WorkflowResult {
  success: boolean
  project?: Project
  nextcloud?: {
    folder_path: string
    share_url?: string
    share_id?: string
  }
  error?: string
}

// ============================================
// NEXTCLOUD CREDENTIALS
// ============================================

function getNextcloudConfig(): NextcloudConfig {
  // TASK-5705: lozinka iz spremišta (zajednički čitač; na čvoru = spremište paketa, upis s ploče);
  // adresa i korisnik nisu tajne — na čvoru dolaze iz okoline usluge ($TM_HOME/config/postavke.env)
  const iz = (ime: string) => procitajTajnuSpremista(ime) || process.env[ime] || ''
  const url = iz('NEXTCLOUD_URL')
  const user = iz('NEXTCLOUD_USER')
  const password = procitajTajnuSpremista('NEXTCLOUD_PASSWORD') || process.env.NEXTCLOUD_PASSWORD || ''

  if (!url || !user || !password) {
    throw new Error('Missing Nextcloud credentials (NEXTCLOUD_URL, NEXTCLOUD_USER, NEXTCLOUD_PASSWORD)')
  }

  return { url, user, password }
}

// ============================================
// NEXTCLOUD API FUNCTIONS
// ============================================

/**
 * Kreira folder u Nextcloud-u (s auto-kreacijom parent foldera)
 */
async function createNextcloudFolder(
  folderPath: string,
  config: NextcloudConfig
): Promise<{ success: boolean; error?: string }> {
  const auth = Buffer.from(`${config.user}:${config.password}`).toString('base64')

  // Prvo osiguraj da parent folder postoji (/PROJEKTI)
  const parentPath = '/PROJEKTI'
  const parentUrl = `${config.url}/remote.php/dav/files/${config.user}${parentPath}`

  try {
    // Pokušaj kreirati parent folder (ignoriraj 405 ako već postoji)
    await fetch(parentUrl, {
      method: 'MKCOL',
      headers: {
        'Authorization': `Basic ${auth}`
      },
      // @ts-ignore - Bun-specific TLS option
      tls: {
        rejectUnauthorized: false
      }
    })
  } catch (error) {
    // Ignoriraj greške - folder možda već postoji
  }

  // Sada kreiraj projekt folder
  const url = `${config.url}/remote.php/dav/files/${config.user}${folderPath}`

  try {
    const response = await fetch(url, {
      method: 'MKCOL',
      headers: {
        'Authorization': `Basic ${auth}`
      },
      // @ts-ignore - Bun-specific TLS option
      tls: {
        rejectUnauthorized: false
      }
    })

    if (response.status === 201 || response.status === 405) {
      // 201 = Created, 405 = Already exists
      return { success: true }
    }

    return {
      success: false,
      error: `HTTP ${response.status}: ${response.statusText}`
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Dijeli folder sa korisnikom
 */
async function shareNextcloudFolder(
  folderPath: string,
  shareWith: string,
  config: NextcloudConfig
): Promise<{ success: boolean; share_id?: string; share_url?: string; error?: string }> {
  const auth = Buffer.from(`${config.user}:${config.password}`).toString('base64')
  const url = `${config.url}/ocs/v2.php/apps/files_sharing/api/v1/shares`

  try {
    const formData = new URLSearchParams({
      path: folderPath,
      shareType: '0', // 0 = User share
      shareWith: shareWith,
      permissions: '31' // All permissions
    })

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'OCS-APIRequest': 'true',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData,
      // @ts-ignore - Bun-specific TLS option
      tls: {
        rejectUnauthorized: false
      }
    })

    const text = await response.text()

    // Parse XML response
    const shareIdMatch = text.match(/<id>(\d+)<\/id>/)
    const shareUrlMatch = text.match(/<url>([^<]+)<\/url>/)

    if (shareIdMatch) {
      return {
        success: true,
        share_id: shareIdMatch[1],
        share_url: shareUrlMatch?.[1]
      }
    }

    // Check if already shared
    if (text.includes('already shared')) {
      return {
        success: true,
        share_id: 'existing'
      }
    }

    return {
      success: false,
      error: `Failed to parse share response: ${text.substring(0, 200)}`
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

// ============================================
// MAIN WORKFLOW
// ============================================

/**
 * Glavni workflow za kreiranje projekta sa Nextcloud integracijom
 */
export async function createProjectWorkflow(
  options: CreateProjectWorkflowOptions
): Promise<WorkflowResult> {
  console.log(`[CreateProjectWorkflow] Starting for project: ${options.name}`)

  try {
    // 1. Get Nextcloud config
    const ncConfig = getNextcloudConfig()
    console.log(`[CreateProjectWorkflow] Nextcloud config loaded: ${ncConfig.url}`)

    // 2. Create Nextcloud folder
    const folderPath = `/PROJEKTI/${options.name}`
    console.log(`[CreateProjectWorkflow] Creating folder: ${folderPath}`)

    const folderResult = await createNextcloudFolder(folderPath, ncConfig)
    if (!folderResult.success) {
      return {
        success: false,
        error: `Failed to create Nextcloud folder: ${folderResult.error}`
      }
    }

    console.log(`[CreateProjectWorkflow] Folder created successfully`)

    // 3. Share folder with users
    const shareUsers = Array.isArray(options.shareWith)
      ? options.shareWith
      : [options.shareWith || 'goran']

    let shareResults: any[] = []
    for (const user of shareUsers) {
      console.log(`[CreateProjectWorkflow] Sharing with user: ${user}`)
      const shareResult = await shareNextcloudFolder(folderPath, user, ncConfig)

      if (shareResult.success) {
        shareResults.push({
          user,
          share_id: shareResult.share_id,
          share_url: shareResult.share_url
        })
        console.log(`[CreateProjectWorkflow] Shared successfully with ${user}`)
      } else {
        console.warn(`[CreateProjectWorkflow] Failed to share with ${user}: ${shareResult.error}`)
      }
    }

    // 4. Create project in TaskManager
    const pm = getProjectManager()

    const projectInput: CreateProjectInput = {
      name: options.name,
      description: options.description,
      priority: options.priority || 3,
      lead_agent: options.lead_agent,
      tags: options.tags || []
    }

    console.log(`[CreateProjectWorkflow] Creating project in TaskManager`)
    const project = pm.createProject(projectInput)

    console.log(`[CreateProjectWorkflow] Project created: ${project.id}`)

    // 5. Update project metadata with Nextcloud info (direct SQL due to Zod v4 z.record issue)
    try {
      const metadata = {
        nextcloud_folder_path: folderPath,
        nextcloud_shares: shareResults,
        created_by_workflow: true,
        workflow_version: '1.0.0'
      }

      // Direct SQL update to bypass Zod validation issue
      const Database = await import('bun:sqlite')
      const db = new Database.default(join(homedir(), '.claude/regoc/data/regoc.db'))
      const stmt = db.prepare('UPDATE projects SET metadata = ? WHERE id = ?')
      stmt.run(JSON.stringify(metadata), project.id)
      db.close()

      console.log(`[CreateProjectWorkflow] Metadata updated via direct SQL`)
    } catch (metaError) {
      console.warn(`[CreateProjectWorkflow] Failed to update metadata:`, metaError)
    }

    // Refresh project to get updated metadata
    const finalProject = pm.getProject(project.id) || project

    return {
      success: true,
      project: finalProject,
      nextcloud: {
        folder_path: folderPath,
        share_url: shareResults[0]?.share_url,
        share_id: shareResults[0]?.share_id
      }
    }
  } catch (error) {
    console.error(`[CreateProjectWorkflow] Error:`, error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

// ============================================
// CLI USAGE
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.log(`
REGOČ Create Project Workflow

Usage:
  bun CreateProjectWorkflow.ts <project-name> [options]

Options:
  --description "Project description"
  --share-with goran,jelena       (comma-separated users, default: goran)
  --priority 1-5                  (default: 3)
  --lead kosjenka                 (agent ID)
  --tags tag1,tag2                (comma-separated)

Examples:
  bun CreateProjectWorkflow.ts "New AI System"
  bun CreateProjectWorkflow.ts "Security Audit" --description "Q1 2026 Security Review" --priority 1
  bun CreateProjectWorkflow.ts "Research" --share-with "goran,jelena" --lead manda
    `)
    process.exit(0)
  }

  const projectName = args[0]
  const options: CreateProjectWorkflowOptions = { name: projectName }

  // Parse arguments
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--description' && args[i + 1]) {
      options.description = args[++i]
    } else if (arg === '--share-with' && args[i + 1]) {
      options.shareWith = args[++i].split(',').map(u => u.trim())
    } else if (arg === '--priority' && args[i + 1]) {
      options.priority = parseInt(args[++i])
    } else if (arg === '--lead' && args[i + 1]) {
      options.lead_agent = args[++i]
    } else if (arg === '--tags' && args[i + 1]) {
      options.tags = args[++i].split(',').map(t => t.trim())
    }
  }

  // Run workflow
  const result = await createProjectWorkflow(options)

  if (result.success) {
    console.log('\n✓ Project created successfully!')
    console.log('\nProject Details:')
    console.log(JSON.stringify(result.project, null, 2))
    console.log('\nNextcloud:')
    console.log(`  Folder: ${result.nextcloud?.folder_path}`)
    console.log(`  Share URL: ${result.nextcloud?.share_url || 'N/A'}`)
  } else {
    console.error('\n✗ Workflow failed!')
    console.error(`  Error: ${result.error}`)
    process.exit(1)
  }
}
