/**
 * Utils Module - Export all utility functions for tool calling
 */

export * from './tools'
// 新的统一工具解析模块
export * from './toolParser/index'
// Preserve unique legacy helpers. Shared names keep the unified module's existing
// semantics; exporting both implementations with export * is ambiguous in ESM.
export { createToolCallState, processStreamContent, createBaseChunk } from './streamToolHandler'
export type { ToolCallState } from './streamToolHandler'
