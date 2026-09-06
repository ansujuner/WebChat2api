import { randomUUID } from 'node:crypto'
import { Transform, type Readable } from 'node:stream'
import { ArenaError, ArenaProtocolDecoder, type ArenaConversation, type ArenaEvent } from '../../arena/protocol.ts'
import type { ProviderConversationState } from '../conversationTypes'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser.ts'
import { getToolProtocol } from '../toolCalling/protocols/index.ts'
import type { ToolCallingPlan } from '../toolCalling/types.ts'

const safeError = (error: unknown): ArenaError => error instanceof ArenaError ? error : new ArenaError('upstream_error')

export class ArenaStreamHandler {
  private readonly model: string
  private readonly sessionId: string
  private readonly plan?: ToolCallingPlan
  private readonly conversation?: ArenaConversation
  private readonly created = Math.floor(Date.now() / 1000)
  private readonly responseId = `chatcmpl_${randomUUID().replace(/-/g, '')}`
  private listener?: (state: ProviderConversationState) => void

  constructor(model: string, sessionId: string, plan?: ToolCallingPlan, conversation?: ArenaConversation) {
    this.model = model
    this.sessionId = sessionId
    this.plan = plan
    this.conversation = conversation ? { ...conversation } : undefined
  }

  setConversationListener(listener?: (state: ProviderConversationState) => void): void { this.listener = listener }

  private completedConversation(): void {
    this.listener?.({ sessionId: this.sessionId, ...(this.conversation ? { extras: { modelId: this.conversation.modelId, modality: this.conversation.modality } } : {}) })
  }

  private base(): Record<string, unknown> {
    return { id: this.responseId, model: this.model, object: 'chat.completion.chunk', created: this.created }
  }

  private terminal(reason: string | undefined, hasTools: boolean): 'stop' | 'length' | 'tool_calls' {
    if (!reason) throw new ArenaError('incomplete_stream', { stage: 'decode' })
    if (!['stop', 'length', 'tool-calls', 'tool_calls'].includes(reason)) throw new ArenaError('upstream_error', { stage: 'decode', protocolCode: 'd' })
    if ((reason === 'tool-calls' || reason === 'tool_calls') && !hasTools) throw new ArenaError('upstream_error', { stage: 'decode', protocolCode: 'd' })
    return reason === 'length' ? 'length' : hasTools ? 'tool_calls' : 'stop'
  }

  async handleStream(input: NodeJS.ReadableStream): Promise<NodeJS.ReadableStream> {
    const source = input as Readable
    const decoder = new ArenaProtocolDecoder()
    const parser = this.plan?.shouldParseResponse ? new ToolStreamParser(this.plan) : undefined
    const base = this.base()
    let finishReason: string | undefined, sourceEnded = false, cleanCompletion = false, started = false
    let output: Transform
    const emit = (value: any) => output.push(`data: ${JSON.stringify(value)}\n\n`)
    const delta = (value: object, finish: string | null = null) => emit({ ...base, choices: [{ index: 0, delta: value, finish_reason: finish }] })
    const start = () => { if (!started) { started = true; delta({ role: 'assistant' }) } }
    const accept = (events: ArenaEvent[]) => {
      for (const event of events) {
        if (event.type === 'image') throw new ArenaError('upstream_error', { stage: 'decode' })
        if (event.type === 'finish') { finishReason = event.reason; continue }
        start()
        if (event.type === 'reasoning') delta({ reasoning_content: event.text })
        else if (parser) for (const chunk of parser.push(event.text, base)) emit(chunk)
        else if (event.text) delta({ content: event.text })
      }
    }
    output = new Transform({
      transform(chunk, _encoding, callback) {
        try { accept(decoder.push(chunk)); callback() } catch (error) { callback(safeError(error)) }
      },
      flush: callback => {
        try {
          accept(decoder.end())
          start()
          if (parser) for (const chunk of parser.flush(base)) emit(chunk)
          const finish = this.terminal(finishReason, parser?.hasEmittedToolCall() ?? false)
          this.completedConversation()
          delta({}, finish)
          output.push('data: [DONE]\n\n')
          cleanCompletion = true
          callback()
        } catch (error) { callback(safeError(error)) }
      },
    })
    // A consumer is attached on the next microtask; retain errors until then.
    output.on('error', () => {})
    source.once('end', () => { sourceEnded = true })
    source.once('error', error => output.destroy(safeError(error)))
    source.once('close', () => { if (!sourceEnded) output.destroy(new ArenaError('incomplete_stream')) })
    output.once('close', () => {
      source.unpipe(output)
      if (!sourceEnded || !cleanCompletion) source.destroy()
    })
    if (source.readableEnded || source.destroyed) output.destroy(new ArenaError('incomplete_stream'))
    else source.pipe(output)
    return output
  }

  async handleNonStream(input: NodeJS.ReadableStream): Promise<any> {
    const source = input as Readable
    const decoder = new ArenaProtocolDecoder()
    let text = '', reasoning = '', finishReason: string | undefined
    const accept = (events: ArenaEvent[]) => {
      for (const event of events) {
        if (event.type === 'image') throw new ArenaError('upstream_error', { stage: 'decode' })
        if (event.type === 'text') text += event.text
        else if (event.type === 'reasoning') reasoning += event.text
        else if (event.type === 'finish') finishReason = event.reason
      }
    }
    try {
      for await (const chunk of source) accept(decoder.push(chunk))
      accept(decoder.end())
      const parsed = this.plan?.shouldParseResponse
        ? getToolProtocol(this.plan.protocol).parse(text, { tools: this.plan.tools, protocol: this.plan.protocol })
        : undefined
      const validCalls = parsed && !parsed.invalidToolNames.length && !parsed.malformedReason ? parsed.toolCalls : []
      const finish = this.terminal(finishReason, !!validCalls?.length)
      this.completedConversation()
      return { id: this.responseId, object: 'chat.completion', created: this.created, model: this.model,
        choices: [{ index: 0, message: { role: 'assistant', content: validCalls?.length ? parsed!.content || null : text,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(validCalls?.length ? { tool_calls: validCalls.map(({ rawText, index, ...call }: any) => call) } : {}),
        }, finish_reason: finish }] }
    } catch (error) { source.destroy(); throw safeError(error) }
  }
}
