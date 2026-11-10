import { createHash, randomBytes } from "node:crypto"
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink, utimes } from "node:fs/promises"
import { dirname, join, sep } from "node:path"

const MAX_PROMPTS = 200
const DEFAULT_MAX_LEDGER = 2000
const LOCK_WAIT_MS = 15000
const EMPTY_LOCK_GRACE_MS = 1000

export function turnKey(device, sessionId, turnId) {
  return createHash("sha256").update(device + "\n" + sessionId + "\n" + turnId).digest("hex").slice(0, 32)
}

export function ovSessionId(device, sessionId) {
  return "cx" + createHash("sha256").update(device + "\n" + sessionId).digest("hex").slice(0, 24)
}

function inside(root, file) {
  const prefix = root.endsWith(sep) ? root : root + sep
  return file === root || file.startsWith(prefix)
}

async function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists and we may not signal it.
    return error.code === "EPERM"
  }
}

async function assertRegular(file, root) {
  const info = await lstat(file)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("ov-codex-memory: state path is not a regular file")
  }
  const real = await realpath(file)
  if (!inside(root, real)) throw new Error("ov-codex-memory: state path escapes the data directory")
  return info
}

export async function createStore(dir, options = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const created = await lstat(dir)
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error("ov-codex-memory: data directory must be a real directory, not a symlink")
  }
  await chmod(dir, 0o700)
  const root = await realpath(dir)
  const maxLedger = options.maxLedger ?? DEFAULT_MAX_LEDGER
  const lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS
  const prompts = join(root, "prompts")
  const turns = join(root, "turns")
  const locks = join(root, "locks")
  await mkdir(prompts, { recursive: true, mode: 0o700 })
  await mkdir(turns, { recursive: true, mode: 0o700 })
  await mkdir(locks, { recursive: true, mode: 0o700 })
  await chmod(prompts, 0o700)
  await chmod(turns, 0o700)
  await chmod(locks, 0o700)

  function fileOf(folder, key) {
    if (!/^[a-f0-9]{32}$/.test(key)) throw new Error("ov-codex-memory: bad state key")
    return join(folder, key + ".json")
  }

  async function atomicWrite(file, value) {
    const existing = await lstat(file).catch((error) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error("ov-codex-memory: refusing to replace a non-regular state file")
    }
    const tmp = join(dirname(file), "." + randomBytes(8).toString("hex") + ".tmp")
    const fh = await open(tmp, "wx", 0o600)
    try {
      await fh.writeFile(JSON.stringify(value))
      await fh.sync()
    } finally {
      await fh.close()
    }
    await chmod(tmp, 0o600)
    await rename(tmp, file)
    await chmod(file, 0o600)
  }

  async function readJSON(file) {
    try {
      await assertRegular(file, root)
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw error
    }
    try {
      return JSON.parse(await readFile(file, "utf8"))
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw new Error("ov-codex-memory: stored state cannot be read")
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function withLock(name, fn) {
    if (!/^[a-f0-9]{32}$/.test(name)) throw new Error("ov-codex-memory: bad lock name")
    const lock = join(locks, name)
    const started = Date.now()
    for (;;) {
      try {
        const fh = await open(lock, "wx", 0o600)
        try {
          await fh.writeFile(String(process.pid))
          await fh.sync()
        } finally {
          await fh.close()
        }
        try {
          return await fn()
        } finally {
          await unlink(lock).catch(() => {})
        }
      } catch (error) {
        if (error.code !== "EEXIST") throw error
        const info = await lstat(lock).catch(() => null)
        if (!info || info.isSymbolicLink() || !info.isFile()) {
          throw new Error("ov-codex-memory: lock path is not a regular file")
        }
        let pid = 0
        try {
          pid = Number(String(await readFile(lock, "utf8")).trim())
        } catch {
          pid = 0
        }
        const alive = await pidAlive(pid)
        const emptyAndOld = !pid && Date.now() - info.mtimeMs >= EMPTY_LOCK_GRACE_MS
        if (!alive && (pid || emptyAndOld)) {
          await unlink(lock).catch(() => {})
          continue
        }
        if (Date.now() - started > lockWaitMs) {
          throw new Error("ov-codex-memory: timed out waiting for this turn's lock")
        }
        await delay(15)
      }
    }
  }

  async function listJson(folder) {
    const names = await readdir(folder).catch(() => [])
    const files = []
    for (const name of names) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) continue
      const file = join(folder, name)
      const info = await lstat(file).catch(() => null)
      if (!info || info.isSymbolicLink() || !info.isFile()) continue
      files.push({ file, mtime: info.mtimeMs, key: name.slice(0, 32) })
    }
    files.sort((a, b) => a.mtime - b.mtime)
    return files
  }

  async function evictPrompts() {
    const files = await listJson(prompts)
    const extra = files.length - MAX_PROMPTS
    if (extra <= 0) return
    let removed = 0
    for (const item of files) {
      if (removed >= extra) break
      const turn = await readJSON(join(turns, item.key + ".json"))
      const terminal = turn && (turn.phase === "accepted" || turn.phase === "settled" || turn.phase === "ambiguous")
      if (!terminal) continue
      await unlink(item.file).catch(() => {})
      removed += 1
    }
  }

  return {
    dir: root,
    key: turnKey,
    sessionId: ovSessionId,
    async savePrompt(device, sessionId, turnId, prompt) {
      const key = turnKey(device, sessionId, turnId)
      return withLock(key, async () => {
        const turn = await readJSON(join(turns, key + ".json"))
        if (turn && (turn.phase === "accepted" || turn.phase === "settled" || turn.phase === "ambiguous")) {
          return { stored: false, reason: "already-captured" }
        }
        const existing = await listJson(prompts)
        const mine = existing.some((item) => item.key === key)
        const live = []
        for (const item of existing) {
          if (item.key === key) continue
          const other = await readJSON(join(turns, item.key + ".json"))
          const terminal = other && (other.phase === "accepted" || other.phase === "settled" || other.phase === "ambiguous")
          if (!terminal) live.push(item)
        }
        if (!mine && live.length >= MAX_PROMPTS) return { stored: false, reason: "full" }
        await atomicWrite(join(prompts, key + ".json"), {
          v: 1, device, sessionId, turnId, prompt, savedAt: new Date().toISOString(),
        })
        await evictPrompts()
        return { stored: true }
      })
    },
    async readPrompt(device, sessionId, turnId) {
      return readJSON(join(prompts, turnKey(device, sessionId, turnId) + ".json"))
    },
    async readTurn(device, sessionId, turnId) {
      return readJSON(join(turns, turnKey(device, sessionId, turnId) + ".json"))
    },
    async countTurns() {
      return (await listJson(turns)).length
    },
    async lockTurn(device, sessionId, turnId, fn) {
      const key = turnKey(device, sessionId, turnId)
      return withLock(key, async () => {
        const file = join(turns, key + ".json")
        const current = await readJSON(file)
        const write = async (next) => {
          const exists = await lstat(file).catch((error) => {
            if (error.code === "ENOENT") return null
            throw error
          })
          if (!exists && (await listJson(turns)).length >= maxLedger) {
            const error = new Error("ov-codex-memory: capture ledger is full; this turn was not sent")
            error.code = "LEDGER_FULL"
            throw error
          }
          await atomicWrite(file, { ...next, updatedAt: new Date().toISOString() })
        }
        return fn(current, write)
      })
    },
    // Test hook: plant a lock file. Not used by the tools.
    async plantLock(device, sessionId, turnId, pid, { old = false } = {}) {
      const lock = join(locks, turnKey(device, sessionId, turnId))
      const fh = await open(lock, "wx", 0o600)
      await fh.writeFile(pid ? String(pid) : "")
      await fh.close()
      if (old) {
        const past = new Date(Date.now() - 5000)
        await utimes(lock, past, past)
      }
    },
  }
}
