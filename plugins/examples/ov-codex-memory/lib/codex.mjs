// Codex hook stdout, matched to openai/codex main
// codex-rs/hooks/src/schema.rs (deny_unknown_fields) and output_parser.rs.
// UserPromptSubmit and Stop were read from that tree for this package.
// A field that is not in those wire structs makes Codex reject the output.

const PROMPT_ROOT = new Set([
  "continue",
  "stopReason",
  "suppressOutput",
  "systemMessage",
  "decision",
  "reason",
  "hookSpecificOutput",
])
const PROMPT_HOOK = new Set(["hookEventName", "additionalContext"])
const STOP_ROOT = new Set([
  "continue",
  "stopReason",
  "suppressOutput",
  "systemMessage",
  "decision",
  "reason",
])

function unknown(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.has(key))
}

/** Throws when text would not parse as a UserPromptSubmit command result. */
export function assertUserPromptSubmit(text) {
  const value = JSON.parse(text)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object")
  const extra = unknown(value, PROMPT_ROOT)
  if (extra.length) throw new Error("unknown field " + extra.join(","))
  if (value.decision !== undefined) throw new Error("decision is not used")
  if (value.reason !== undefined) throw new Error("reason is not used")
  if (value.continue === false) throw new Error("continue:false is not used")
  if (value.systemMessage !== undefined && typeof value.systemMessage !== "string") {
    throw new Error("systemMessage")
  }
  const hook = value.hookSpecificOutput
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) throw new Error("hookSpecificOutput")
  const hookExtra = unknown(hook, PROMPT_HOOK)
  if (hookExtra.length) throw new Error("unknown hook field " + hookExtra.join(","))
  if (hook.hookEventName !== "UserPromptSubmit") throw new Error("hookEventName")
  if (hook.additionalContext !== undefined && typeof hook.additionalContext !== "string") {
    throw new Error("additionalContext")
  }
  return value
}

/** Throws when text would not parse as a Stop command result, or would continue the turn. */
export function assertStop(text) {
  const value = JSON.parse(text)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object")
  const extra = unknown(value, STOP_ROOT)
  if (extra.length) throw new Error("unknown field " + extra.join(","))
  if (value.decision !== undefined) throw new Error("decision would continue the turn")
  if (value.reason !== undefined) throw new Error("reason is not used")
  if (value.continue === false) throw new Error("continue:false is not used")
  if (value.stopReason !== undefined) throw new Error("stopReason is not used")
  if (value.suppressOutput !== undefined) throw new Error("suppressOutput is not used")
  if (value.systemMessage !== undefined && typeof value.systemMessage !== "string") {
    throw new Error("systemMessage")
  }
  return value
}

export function userPromptSubmit(additionalContext, systemMessage) {
  const out = { hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }
  if (typeof additionalContext === "string" && additionalContext.length > 0) {
    out.hookSpecificOutput.additionalContext = additionalContext
  }
  if (systemMessage) out.systemMessage = systemMessage
  const text = JSON.stringify(out)
  assertUserPromptSubmit(text)
  return text
}

export function stopResult(systemMessage) {
  const out = {}
  if (systemMessage) out.systemMessage = systemMessage
  const text = JSON.stringify(out)
  assertStop(text)
  return text
}
