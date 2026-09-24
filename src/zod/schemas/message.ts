import { z } from 'zod'
import { AgentIdSchema } from './task'

// Message type enum
export const MessageTypeSchema = z.enum([
  'text', 'voice', 'command', 'relay', 'upgrade', 'notification'
])

// Message status enum
export const MessageStatusSchema = z.enum([
  'pending', 'processing', 'completed', 'failed', 'cancelled'
])

// Main Message schema
export const MessageSchema = z.object({
  id: z.string().uuid(),
  from_agent: AgentIdSchema,
  to_agent: AgentIdSchema,
  content: z.string(),
  type: MessageTypeSchema.default('text'),
  priority: z.number().int().min(1).max(5).default(3),
  status: MessageStatusSchema.default('pending'),
  created_at: z.string(),
  processed_at: z.string().optional(),
  error: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  chat_id: z.string().optional(),
  voice_relay: z.boolean().optional(),
  retry_count: z.number().int().min(0).default(0),
  max_retries: z.number().int().min(0).default(3),
  response: z.string().optional(),
  expires_at: z.string().optional(),
})

// Input schema for sending messages
export const SendMessageInputSchema = z.object({
  from_agent: AgentIdSchema,
  to_agent: AgentIdSchema,
  content: z.string().min(1),
  type: MessageTypeSchema.optional(),
  priority: z.number().int().min(1).max(5).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
})

// Type exports
export type Message = z.infer<typeof MessageSchema>
export type MessageType = z.infer<typeof MessageTypeSchema>
export type MessageStatus = z.infer<typeof MessageStatusSchema>
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>
