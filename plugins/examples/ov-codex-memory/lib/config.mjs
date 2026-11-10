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

/**
 * Connection for the Magpie host. apiKey comes from ovcli.conf or from the
 * plugin option used in tests. This is the OpenViking key on this computer,
 * never a Magpie gateway key.
 */
export async function loadConfig(env, options, home) {
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
  const url = options.url || parsed.url || DEFAULT_URL
  const apiKey = options.apiKey || parsed.api_key || ""
  if (typeof url !== "string" || typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("ov-codex-memory: set url and api_key in ovcli.conf on this computer")
  }
  return {
    baseUrl: assertLoopback(url),
    apiKey: apiKey.trim(),
    timeoutMs: clampTimeout(options.timeoutMs),
    file,
  }
}
