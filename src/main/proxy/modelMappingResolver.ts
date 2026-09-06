import type { ModelMapping } from '../store/types'

const maxNameLength = 256
const validName = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= maxNameLength && !/[\x00-\x1f\x7f]/.test(value)
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Documented globs contain one star: prefix*, *suffix or prefix*suffix. */
export function matchesModelPattern(requested: string, pattern: string): boolean {
  if (!validName(requested) || !validName(pattern)) return false
  const parts = pattern.split('*')
  if (parts.length > 2) return false
  return new RegExp(`^${parts.map(escapeRegex).join('.*')}$`, 'i').test(requested)
}

/** Exact aliases win; more-specific globs precede a catch-all. Never redirect Arena aliases. */
export function resolveModelMapping(requested: string, value: unknown, providerId?: string): ModelMapping | undefined {
  if (!validName(requested) || /^arena\//i.test(requested) || !value || typeof value !== 'object' || Array.isArray(value)) return
  const mappings = value as Record<string, ModelMapping>
  const usable = (mapping: unknown): mapping is ModelMapping => !!mapping && typeof mapping === 'object' && validName((mapping as ModelMapping).actualModel)
  const exact = Object.hasOwn(mappings, requested) ? mappings[requested] : undefined
  const selected = usable(exact) ? exact : Object.entries(mappings)
    .filter(([pattern, mapping]) => pattern.includes('*') && usable(mapping) && matchesModelPattern(requested, pattern))
    .sort(([a], [b]) => b.length - a.length)[0]?.[1]
  if (!selected || (providerId && selected.preferredProviderId && selected.preferredProviderId !== providerId)) return
  return selected
}
