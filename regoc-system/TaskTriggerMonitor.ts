#!/usr/bin/env bun
/**
 * Task Trigger Monitor
 *
 * Monitors TaskManager WebSocket for task events and sends Telegram notifications.
 *
 * Usage:
 *   bun ~/.claude/regoc/TaskTriggerMonitor.ts
 *
 * Events monitored:
 *   - task_created: New task created
 *   - task_updated: Task modified (status, priority, assignee)
 *   - task_deleted: Task removed
 */

import { $ } from "bun"

const WS_URL = 'ws://localhost:3001/stream'
const REGOC_CLIENT = `${process.env.HOME}/.claude/regoc/RegocClient.ts`

interface TaskEvent {
  type: 'initial' | 'task_created' | 'task_updated' | 'task_deleted' | 'file_changed'
  task?: {
    id: string
    title: string
    status: string
    priority: number
    assignee?: string
    description?: string
  }
  taskId?: string
  tasks?: any[]
  filename?: string
  timestamp?: string
}

function formatPriority(p: number): string {
  switch(p) {
    case 1: return '🔴 P1 (CRITICAL)'
    case 2: return '🟡 P2 (HIGH)'
    case 3: return '🔵 P3 (NORMAL)'
    default: return `P${p}`
  }
}

function formatStatus(s: string): string {
  switch(s) {
    case 'pending': return '⏳ Pending'
    case 'in_progress': return '🔄 In Progress'
    case 'completed': return '✅ Completed'
    case 'blocked': return '🚫 Blocked'
    default: return s
  }
}

async function sendTelegram(message: string) {
  try {
    await $`bun ${REGOC_CLIENT} send regoc klaudio ${message}`.quiet()
    console.log(`[Telegram] Sent: ${message.substring(0, 50)}...`)
  } catch (error) {
    console.error('[Telegram] Failed to send:', error)
  }
}

function handleEvent(event: TaskEvent) {
  const now = new Date().toLocaleTimeString('hr-HR')

  switch(event.type) {
    case 'initial':
      console.log(`[${now}] Connected. Monitoring ${event.tasks?.length || 0} tasks...`)
      break

    case 'task_created':
      if (event.task) {
        const msg = `🆕 TASK KREIRAN\n` +
          `ID: ${event.task.id}\n` +
          `📋 ${event.task.title}\n` +
          `${formatPriority(event.task.priority)}\n` +
          `👤 ${event.task.assignee || 'Nedodijeljeno'}`
        sendTelegram(msg)
        console.log(`[${now}] CREATED: ${event.task.id} - ${event.task.title}`)
      }
      break

    case 'task_updated':
      if (event.task) {
        const msg = `📝 TASK AŽURIRAN\n` +
          `ID: ${event.task.id}\n` +
          `📋 ${event.task.title}\n` +
          `${formatStatus(event.task.status)}\n` +
          `${formatPriority(event.task.priority)}\n` +
          `👤 ${event.task.assignee || 'Nedodijeljeno'}`
        sendTelegram(msg)
        console.log(`[${now}] UPDATED: ${event.task.id} → ${event.task.status}`)
      }
      break

    case 'task_deleted':
      const delMsg = `🗑️ TASK OBRISAN: ${event.taskId}`
      sendTelegram(delMsg)
      console.log(`[${now}] DELETED: ${event.taskId}`)
      break

    case 'file_changed':
      console.log(`[${now}] File changed: ${event.filename}`)
      break
  }
}

function connect() {
  console.log(`\n🔌 Connecting to TaskManager WebSocket...`)
  console.log(`   URL: ${WS_URL}\n`)

  const ws = new WebSocket(WS_URL)

  ws.onopen = () => {
    console.log('✅ Connected! Listening for task events...')
    console.log('   Press Ctrl+C to stop\n')
    console.log('─'.repeat(50))
  }

  ws.onmessage = (event) => {
    try {
      const data: TaskEvent = JSON.parse(event.data.toString())
      handleEvent(data)
    } catch (error) {
      console.error('Failed to parse event:', error)
    }
  }

  ws.onerror = (error) => {
    console.error('❌ WebSocket error:', error)
  }

  ws.onclose = () => {
    console.log('\n⚠️ Connection closed. Reconnecting in 3s...')
    setTimeout(connect, 3000)
  }
}

// Main
console.log('╔══════════════════════════════════════════════════╗')
console.log('║       REGOČ Task Trigger Monitor v3.0            ║')
console.log('║  Monitors tasks and sends Telegram notifications ║')
console.log('╚══════════════════════════════════════════════════╝')

connect()
