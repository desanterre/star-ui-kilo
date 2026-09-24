import type { OfficeState } from "./protocol"

// Kilo built-in tools, grouped by the Star Office area they map to.
const RESEARCHING = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "ls",
  "webfetch",
  "websearch",
  "codesearch",
  "codebase_search",
  "semantic_search",
  "lsp",
  "todoread",
  "skill",
  "question",
  "ask_teammate",
])
const WRITING = new Set(["edit", "write", "patch", "apply_patch", "multiedit", "todowrite", "notebook_edit"])
const EXECUTING = new Set(["bash", "shell", "task", "batch"])

// MCP tools are named "<server>_<tool>": fall back to keyword heuristics.
const RESEARCH_WORDS = /(search|read|fetch|get|list|find|query|lookup|browse|view|inspect|describe)/
const WRITE_WORDS = /(write|edit|create|update|patch|insert|replace|delete|rename|commit)/

export function toolState(tool: string): OfficeState {
  const name = tool.toLowerCase()
  if (RESEARCHING.has(name)) return "researching"
  if (WRITING.has(name)) return "writing"
  if (EXECUTING.has(name)) return "executing"
  if (name.startsWith("lsp")) return "researching"
  if (WRITE_WORDS.test(name)) return "writing"
  if (RESEARCH_WORDS.test(name)) return "researching"
  return "executing"
}

export function isAbortError(name?: string): boolean {
  return name === "MessageAbortedError" || name === "AbortError"
}
