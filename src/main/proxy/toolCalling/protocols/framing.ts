import type { ToolProtocolId } from '../types.ts'

const XML_MARKERS = [
  ['<|CHAT2API|tool_calls>', '</|CHAT2API|tool_calls>'],
  ['<tool_calls>', '</tool_calls>'],
] as const
export function protocolMarkers(protocol: ToolProtocolId): ReadonlyArray<readonly [string, string]> {
  if (protocol === 'managed_xml') return XML_MARKERS
  if (protocol === 'anthropic_tool_use') return [['<antml:function_calls>', '</antml:function_calls>']]
  if (protocol === 'managed_bracket' || protocol === 'openai_chat') return [['[function_calls]', '[/function_calls]']]
  return []
}

/** Find a structural delimiter, not one contained in an argument's CDATA/JSON string. */
export function findClosingMarker(text: string, closing: string, start: number, jsonStrings = false): number {
  let quoted = false, escaped = false
  for (let i = start; i < text.length; i++) {
    if (!quoted && text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9)
      if (end === -1) return -1
      i = end + 2
      continue
    }
    if (!quoted && text.startsWith(closing, i)) return i
    if (jsonStrings) {
      const char = text[i]
      if (quoted && escaped) escaped = false
      else if (quoted && char === '\\') escaped = true
      else if (char === '"') quoted = !quoted
    }
  }
  return -1
}

export interface FramedPart {
  kind: 'tool' | 'fence' | 'partial'
  start: number
  /** Exclusive end, absent until this frame/fence is complete. */
  end?: number
  opening?: string
  closing?: string
}

function findFenceEnd(text: string, start: number, fence: string, atEnd: boolean): number | undefined {
  const lines = /\r\n|\r|\n/g
  lines.lastIndex = start + fence.length
  const openerEnd = lines.exec(text)
  if (!openerEnd) return undefined
  let cursor = openerEnd.index + openerEnd[0].length
  const closing = new RegExp('^[ \\t]{0,3}' + fence[0] + '{' + fence.length + ',}[ \\t]*$')
  while (cursor <= text.length) {
    lines.lastIndex = cursor
    const next = lines.exec(text)
    // At a chunk boundary, more non-whitespace might follow an apparent closer.
    // Wait for the newline or real EOF instead of exposing the example body.
    if (!next && !atEnd) return undefined
    const end = next?.index ?? text.length
    if (closing.test(text.slice(cursor, end))) return next ? next.index + next[0].length : end
    if (!next) return undefined
    cursor = next.index + next[0].length
  }
  return undefined
}

/** Markdown fences apply outside tool envelopes only: Write.content may itself contain code fences. */
export function findFramedPart(text: string, protocol: ToolProtocolId, atEnd = true): FramedPart | undefined {
  const markers = protocolMarkers(protocol)
  for (let i = 0; i < text.length; i++) {
    const suffix = text.slice(i)
    const fence = /^(?:`{3,}|~{3,})/.exec(suffix)?.[0]
    if (fence) {
      const end = findFenceEnd(text, i, fence, atEnd)
      return { kind: 'fence', start: i, ...(end !== undefined ? { end } : {}) }
    }
    for (const [opening, closing] of markers) {
      if (suffix.startsWith(opening)) {
        const close = findClosingMarker(text, closing, i + opening.length, opening.startsWith('['))
        return { kind: 'tool', start: i, opening, closing, ...(close >= 0 ? { end: close + closing.length } : {}) }
      }
    }
    if (markers.some(([opening]) => opening.startsWith(suffix)) || '```'.startsWith(suffix) || '~~~'.startsWith(suffix)) {
      return { kind: 'partial', start: i }
    }
  }
  return undefined
}
