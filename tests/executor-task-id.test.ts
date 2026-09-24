/**
 * TASK-5013 — izvođač agentu stavlja TM_TASK_ID u okolinu, jer po njemu hook
 * `hooks/TaskInstructionsInject.hook.ts` zna za koji zadatak preuzima dodatne upute.
 */
import { describe, test, expect } from 'bun:test'
import { CliExecutor } from '../src/core/orchestrator/Executors'

const ispisOkoline = () => new CliExecutor('env', {
  kind: 'cli', command: 'printenv', args: ['TM_TASK_ID'], promptChannel: 'stdin', promptFlag: null,
} as any)

describe('CliExecutor → TM_TASK_ID', () => {
  test('s ID-em zadatka agent ga vidi u okolini', async () => {
    const r = await ispisOkoline().run({ agentId: 'a', prompt: 'x', taskId: 'TASK-42' })
    expect(r.resultText).toBe('TASK-42')
  })
  test('bez ID-a zadatka okolina ga ne izmišlja', async () => {
    const r = await ispisOkoline().run({ agentId: 'a', prompt: 'x' })
    expect(r.resultText).toBe('')
  })
})
