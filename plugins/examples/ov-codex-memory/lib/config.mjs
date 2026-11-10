import { lstat, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { assertLoopback } from "./loopback.mjs"

const DEFAULT_URL = "http://127.0.0.1:1933"

function clampTimeout(value) {
  const n = Number(value)
  if (!Number.isInteger(n)) return 8000
  return Math.min(15000, Math.max(100, n))
}

function configFile(env, home) {
  const named = env.OPENVIKING_CLI_CONFIG_FILE
  if (typeof named === "string" && named.trim()) return named.trim()
  return join(home || homedir(), ".openviking", "ovcli.conf")
}

// Empty, missing, and JSON null are the official no-key loopback client.
// A non-string value is refused without echoing it. A line break would be a
// header injection and is refused the same way.
export function keyFrom(value) {
  if (value == null) return ""
  if (typeof value !== "string" || /[\r\n]/.test(value)) {
    throw new Error("ov-codex-memory: api_key must be a single-line string, empty, or omitted")
  }
  return value.trim()
}

/**
 * Connection for the Magpie host. An empty api_key is valid on loopback and
 * means no Authorization header. A non-loopback URL is still refused. This
 * key, when present, is the OpenViking key on this computer, never a Magpie
 * gateway key.
 */
export async function loadConfig(env, options = {}, home) {
  const file = configFile(env, home)
  let parsed = {}
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.size > 65536) throw new Error("ov-codex-memory: ovcli.conf cannot be read")
    parsed = JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("ov-codex-memory: ovcli.conf cannot be read")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) parsed = {}
  const picked = typeof options.url === "string" && options.url.trim()
    ? options.url.trim()
    : (typeof parsed.url === "string" && parsed.url.trim() ? parsed.url.trim() : DEFAULT_URL)
  const apiKey = options.apiKey !== undefined ? keyFrom(options.apiKey) : keyFrom(parsed.api_key)
  return {
    baseUrl: assertLoopback(picked),
    apiKey,
    timeoutMs: clampTimeout(options.timeoutMs),
    file,
  }
}
