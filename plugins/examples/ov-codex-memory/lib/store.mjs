import { createHash } from "node:crypto"
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const MAX_PROMPTS = 200
const MAX_TURNS = 500
const LOCK_WAIT_MS = 15000
const LOCK_STALE_MS = 20000

export function turnKey(device, sessionId, turnId) {
  return createHash("sha256").update(device + "\n" + sessionId + "\n" + turnId).digest("hex").slice(0, 32)
}

export function ovSessionId(device, sessionId) {
  return "cx" + createHash("sha256").update(device + "\n" + sessionId).digest("hex").slice(0, 24)
}

export function sourceId(device, sessionId, turnId, role) {
  return "ovcx-" + createHash("sha256").update(device + "\n" + sessionId + "\n" + turnId + "\n" + role).digest("hex").slice(0, 40)
}

async function atomicWrite(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2)
  const fh = await open(tmp, "w", 0o600)
  try {
    await fh.writeFile(JSON.stringify(value))
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmp, file)
}

async function readJSON(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw new Error("ov-codex-memory: stored state for this turn cannot be read")
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createStore(dir) {
  const prompts = join(dir, "prompts")
  const turns = join(dir, "turns")
  const locks = join(dir, "locks")

  async function withLock(name, fn) {
    await mkdir(locks, { recursive: true })
    const lock = join(locks, name)
    const started = Date.now()
    for (;;) {
      try {
        const fh = await open(lock, "wx", 0o600)
        await fh.close()
        try {
          return await fn()
        } finally {
          await unlink(lock).catch(() => {})
        }
      } catch (error) {
        if (error.code !== "EEXIST") throw error
        const info = await stat(lock).catch(() => null)
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(lock).catch(() => {})
          continue
        }
        if (Date.now() - started > LOCK_WAIT_MS) {
          throw new Error("ov-codex-memory: timed out waiting for this turn's lock")
        }
        await delay(15)
      }
    }
  }

  async function evict(folder, max) {
    const names = await readdir(folder).catch(() => [])
    const files = []
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const file = join(folder, name)
      const info = await stat(file).catch(() => null)
      if (info) files.push({ file, mtime: info.mtimeMs })
    }
    files.sort((a, b) => a.mtime - b.mtime)
    while (files.length > max) {
      const oldest = files.shift()
      await rm(oldest.file, { force: true })
    }
  }

  return {
    dir,
    key: turnKey,
    sessionId: ovSessionId,
    async savePrompt(device, sessionId, turnId, prompt) {
      const key = turnKey(device, sessionId, turnId)
      return withLock(key, async () => {
        const turn = await readJSON(join(turns, key + ".json"))
        if (turn && (turn.phase === "accepted" || turn.phase === "settled")) return { stored: false, reason: "already-captured" }
        await mkdir(prompts, { recursive: true })
        await atomicWrite(join(prompts, key + ".json"), {
          v: 1, device, sessionId, turnId, prompt, savedAt: new Date().toISOString(),
        })
        await evict(prompts, MAX_PROMPTS)
        return { stored: true }
      })
    },
    async readPrompt(device, sessionId, turnId) {
      return readJSON(join(prompts, turnKey(device, sessionId, turnId) + ".json"))
    },
    async readTurn(device, sessionId, turnId) {
      return readJSON(join(turns, turnKey(device, sessionId, turnId) + ".json"))
    },
    async lockTurn(device, sessionId, turnId, fn) {
      await mkdir(turns, { recursive: true })
      const key = turnKey(device, sessionId, turnId)
      return withLock(key, async () => {
        const file = join(turns, key + ".json")
        const current = await readJSON(file)
        const write = async (next) => {
          await atomicWrite(file, { ...next, updatedAt: new Date().toISOString() })
          await evict(turns, MAX_TURNS)
        }
        return fn(current, write)
      })
    },
  }
}
