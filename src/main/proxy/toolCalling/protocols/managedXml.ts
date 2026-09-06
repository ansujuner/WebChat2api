import type { ToolProtocolAdapter } from './base.ts'
import type { ToolParseContext, NormalizedToolDefinition } from '../types.ts'
import { buildToolCall, createToolCallId, createParseResult, detectMarkers, escapeXmlAttribute, decodeXml,
  parseJsonValue, renderToolList, unwrapCdata, wrapCdata } from './shared.ts'
import { findClosingMarker, findFramedPart } from './framing.ts'

const CHAT2API_START = '<|CHAT2API|tool_calls>'
const CHAT2API_END = '</|CHAT2API|tool_calls>'
const XML_START = '<tool_calls>'
const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key)

export const managedXmlProtocol: ToolProtocolAdapter = {
  id: 'managed_xml',
  renderPrompt(tools) {
    return `## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.
Use only the exact tool names listed below. Do not rename, camelCase, translate, shorten, or invent tool names.

${renderToolList(tools)}

When calling tools, respond with only this Chat2API XML block:

<|CHAT2API|tool_calls><|CHAT2API|invoke name="exact_tool_name"><|CHAT2API|parameter name="argument"><![CDATA[value]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>

String parameter contents are literal text. For object, array, number and boolean parameters, use valid JSON matching the schema.
Tool results will be provided as Chat2API XML result blocks:

<|CHAT2API|tool_result tool_call_id="call_id"><![CDATA[result]]></|CHAT2API|tool_result>`
  },
  detectStart(buffer) { return detectMarkers(buffer, [CHAT2API_START, XML_START]) },
  parse(content: string, context: ToolParseContext) {
    const rawMatches: string[] = [], invalidToolNames: string[] = []
    const toolCalls: ReturnType<typeof buildToolCall>[] = []
    const kept: string[] = []
    let offset = 0, malformedReason: string | undefined
    while (offset < content.length) {
      const part = findFramedPart(content.slice(offset), 'managed_xml')
      if (!part || part.end === undefined) { kept.push(content.slice(offset)); break }
      kept.push(content.slice(offset, offset + part.start))
      const raw = content.slice(offset + part.start, offset + part.end)
      offset += part.end
      if (part.kind !== 'tool') { kept.push(raw); continue }
      rawMatches.push(raw)
      const body = raw.slice(part.opening!.length, -part.closing!.length)
      const tagPrefix = part.opening === CHAT2API_START ? '|CHAT2API|' : ''
      try {
        for (const invoke of readElements(body, tagPrefix, 'invoke')) {
          const tool = context.tools.find(tool => tool.name === invoke.name)
          if (!tool) { invalidToolNames.push(invoke.name); continue }
          const args = readArguments(invoke.body, tagPrefix, tool)
          toolCalls.push(buildToolCall(createToolCallId(), toolCalls.length, invoke.name, JSON.stringify(args), invoke.raw))
        }
      } catch { malformedReason = 'invalid_xml_tool_arguments' }
    }
    // Never turn a partially malformed envelope into a partial set of actions.
    const valid = !invalidToolNames.length && !malformedReason && toolCalls.length > 0
    return createParseResult({ content: valid ? kept.join('').trim() : content,
      toolCalls: valid ? toolCalls : [], protocol: rawMatches.length ? 'managed_xml' : 'unknown',
      rawMatches, invalidToolNames, malformedReason })
  },
  formatAssistantToolCalls(calls) {
    const invokes = calls.map(call => {
      const args = JSON.parse(call.arguments || '{}')
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object')
      const params = Object.entries(args).map(([name, value]) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value)
        return `<|CHAT2API|parameter name="${escapeXmlAttribute(name)}">${wrapCdata(text)}</|CHAT2API|parameter>`
      }).join('')
      return `<|CHAT2API|invoke name="${escapeXmlAttribute(call.name)}">${params}</|CHAT2API|invoke>`
    })
    return `${CHAT2API_START}${invokes.join('')}${CHAT2API_END}`
  },
  formatToolResult(result) {
    return `<|CHAT2API|tool_result tool_call_id="${escapeXmlAttribute(result.toolCallId)}">${wrapCdata(result.content)}</|CHAT2API|tool_result>`
  },
}

function readElements(content: string, prefix: string, kind: 'invoke' | 'parameter'): Array<{ name: string; body: string; raw: string }> {
  const tag = `${prefix}${kind}`
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const opening = new RegExp(`^<${escaped}\\s+name=(["'])(.*?)\\1\\s*>`)
  const closing = `</${tag}>`
  const elements: Array<{ name: string; body: string; raw: string }> = []
  let remaining = content
  while (remaining.trim()) {
    remaining = remaining.trimStart()
    const match = opening.exec(remaining)
    if (!match) throw new Error('Malformed tool XML')
    const end = findClosingMarker(remaining, closing, match[0].length)
    if (end < 0) throw new Error('Unclosed tool XML')
    const name = decodeXml(match[2].trim())
    if (!name) throw new Error('Empty XML name')
    elements.push({ name, body: remaining.slice(match[0].length, end), raw: remaining.slice(0, end + closing.length) })
    remaining = remaining.slice(end + closing.length)
  }
  return elements
}

function readArguments(content: string, prefix: string, tool: NormalizedToolDefinition): Record<string, unknown> {
  let args: Record<string, unknown> = {}
  const properties = tool.parameters.properties as Record<string, any> | undefined
  for (const parameter of readElements(content, prefix, 'parameter')) {
    if (hasOwn(args, parameter.name)) throw new Error('Duplicate tool parameter')
    if (tool.parameters.additionalProperties === false && !hasOwn(properties || {}, parameter.name)) throw new Error('Unknown tool parameter')
    const schema = properties && hasOwn(properties, parameter.name) ? properties[parameter.name] : undefined
    const types: string[] = typeof schema?.type === 'string' ? [schema.type] : Array.isArray(schema?.type) ? schema.type : []
    const cdata = parameter.body.trimStart().startsWith('<![CDATA[')
    const literal = cdata ? unwrapCdata(parameter.body) : decodeXml(parameter.body)
    let value: unknown
    // File contents, shell commands and replacement strings must not be parsed
    // as JSON merely because their literal text resembles a boolean or object.
    if (types.includes('string')) value = literal
    else if (types.length) {
      value = JSON.parse(literal.trim())
      const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      if (!types.includes(actual) && !(types.includes('integer') && typeof value === 'number' && Number.isInteger(value))) throw new Error('Tool parameter type mismatch')
    } else value = parseJsonValue(parameter.body)
    args = { ...args, [parameter.name]: value }
  }
  if (Array.isArray(tool.parameters.required) && tool.parameters.required.some(name => typeof name === 'string' && !hasOwn(args, name))) {
    throw new Error('Missing required tool parameter')
  }
  return args
}
