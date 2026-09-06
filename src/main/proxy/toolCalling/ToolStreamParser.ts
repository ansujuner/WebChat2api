import type { ToolCallingPlan } from './types.ts'
import { getToolProtocol } from './protocols/index.ts'
import { findFramedPart } from './protocols/framing.ts'

const MAX_TOOL_BUFFER = 16 * 1024 * 1024

export class ToolStreamParser {
  private readonly plan: ToolCallingPlan
  private buffer = ''
  private emittedToolCall = false
  private nextToolCallIndex = 0

  constructor(plan: ToolCallingPlan) { this.plan = plan }

  push(content: string, baseChunk: any, includeRole = false): any[] {
    if (!content || !this.plan.shouldParseResponse) return []
    this.buffer += content
    if (this.buffer.length > MAX_TOOL_BUFFER) throw new Error('Tool response exceeds the supported buffer size')
    // A Responses JSON item/array has no textual envelope. Validate it as one
    // complete document at EOF rather than guessing where a partial item ends.
    if (this.plan.protocol === 'codex_responses') return []
    const chunks: any[] = []
    while (this.buffer) {
      const part = findFramedPart(this.buffer, this.plan.protocol, false)
      if (!part) {
        chunks.push(createContentChunk(baseChunk, this.buffer, includeRole && !chunks.length))
        this.buffer = ''
        break
      }
      if (part.start > 0) {
        chunks.push(createContentChunk(baseChunk, this.buffer.slice(0, part.start), includeRole && !chunks.length))
        this.buffer = this.buffer.slice(part.start)
      }
      if (part.end === undefined) break
      const end = part.end - part.start
      const raw = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end)
      if (part.kind === 'fence') chunks.push(createContentChunk(baseChunk, raw, includeRole && !chunks.length))
      else chunks.push(...this.emitParsed(raw, baseChunk, includeRole && !chunks.length))
    }
    return chunks
  }

  private emitParsed(raw: string, baseChunk: any, includeRole: boolean): any[] {
    const parsed = getToolProtocol(this.plan.protocol).parse(raw, { tools: this.plan.tools, protocol: this.plan.protocol })
    // An invalid tool envelope is visible text, not a silently discarded or
    // partially executable instruction. The client never receives invalid JSON.
    const validJsonObjects = parsed.toolCalls.every(call => {
      try { const value = JSON.parse(call.function.arguments); return value && typeof value === 'object' && !Array.isArray(value) }
      catch { return false }
    })
    if (!parsed.toolCalls.length || parsed.invalidToolNames.length || parsed.malformedReason || !validJsonObjects) {
      return [createContentChunk(baseChunk, raw, includeRole)]
    }
    const chunks = parsed.toolCalls.map((toolCall, offset) => {
      const indexed = { ...toolCall, index: this.nextToolCallIndex + offset }
      return createToolCallChunk(baseChunk, indexed, includeRole && offset === 0)
    })
    this.nextToolCallIndex += parsed.toolCalls.length
    this.emittedToolCall = true
    return chunks
  }

  flush(baseChunk: any): any[] {
    if (!this.buffer) return []
    const raw = this.buffer
    this.buffer = ''
    return this.plan.protocol === 'codex_responses'
      ? this.emitParsed(raw, baseChunk, false)
      : [createContentChunk(baseChunk, raw, false)]
  }

  hasEmittedToolCall(): boolean { return this.emittedToolCall }
  isBuffering(): boolean { return this.buffer.length > 0 }
}

function createContentChunk(baseChunk: any, content: string, includeRole: boolean): any {
  return { ...baseChunk, choices: [{ index: 0, delta: { ...(includeRole ? { role: 'assistant' } : {}), content }, finish_reason: null }] }
}

function createToolCallChunk(baseChunk: any, toolCall: any, includeRole: boolean): any {
  const { rawText, ...openAiToolCall } = toolCall
  void rawText
  return { ...baseChunk, choices: [{ index: 0, delta: { ...(includeRole ? { role: 'assistant' } : {}), tool_calls: [openAiToolCall] }, finish_reason: null }] }
}
