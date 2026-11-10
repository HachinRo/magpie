import { homedir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "./lib/config.mjs"
import { createClient } from "./lib/http.mjs"
import { createStore } from "./lib/store.mjs"
import { createTools } from "./lib/tools.mjs"

async function open(options, env) {
  const cfg = await loadConfig(env, options || {}, homedir())
  const dataDir = typeof options?.dataDir === "string" && options.dataDir.trim()
    ? options.dataDir.trim()
    : join(homedir(), ".openviking", "ov-codex-memory")
  return { store: createStore(dataDir), ov: createClient(cfg) }
}

// Tools only. No onRequest, onResponse, or magpie.hooks, so a model call
// cannot re-enter this plugin.
export default async function ovCodexMemory(_input, options = {}) {
  const { store, ov } = await open(options, process.env)
  return { tool: createTools({ store, ov }) }
}
