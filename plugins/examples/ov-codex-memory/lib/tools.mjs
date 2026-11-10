import { hookCapture, hookContext, hookTask } from "./service.mjs"

const string = { type: "string", minLength: 1, maxLength: 16000 }
const id = { type: "string", minLength: 1, maxLength: 128 }

function tool(description, properties, required, run) {
  return {
    description,
    args: { type: "object", properties, required, additionalProperties: false },
    async execute(args, ctx) {
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("ov-codex-memory: arguments must be an object")
      }
      for (const key of required) {
        if (args[key] == null || args[key] === "") throw new Error("ov-codex-memory: missing " + key)
      }
      return run(args, ctx?.abort)
    },
  }
}

export function createTools({ store, ov }) {
  return {
    hook_context: tool(
      "Codex UserPromptSubmit hook only. Saves the prompt and returns Codex hook JSON with bounded untrusted OpenViking notes from read-only find. Does not call a chat model.",
      { query: string, session_id: id, turn_id: id, device: { type: "string", minLength: 1, maxLength: 64 } },
      ["query", "session_id", "turn_id", "device"],
      (args, signal) => hookContext(store, ov, args, signal),
    ),
    hook_capture: tool(
      "Codex Stop hook only. Captures the prompt saved for this device, session and turn plus the assistant text, once. Does not capture assistant text alone and does not call a chat model.",
      { session_id: id, turn_id: id, device: { type: "string", minLength: 1, maxLength: 64 }, assistant: string },
      ["session_id", "turn_id", "device", "assistant"],
      (args, signal) => hookCapture(store, ov, args, signal),
    ),
    hook_task: tool(
      "Read one OpenViking extraction task. Not a Codex hook: its JSON is not Stop or UserPromptSubmit output. completed means extraction finished, which is separate from archived:true.",
      { task_id: id },
      ["task_id"],
      (args, signal) => hookTask(store, ov, args, signal),
    ),
  }
}
