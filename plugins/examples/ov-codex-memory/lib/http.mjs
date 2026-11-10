// Loopback OpenViking HTTP. Redirects are errors. Response bodies are not
// copied into errors: they can echo the key or the conversation.

export class OvError extends Error {
  constructor(message, kind, status = 0) {
    super(message)
    this.name = "OvError"
    this.kind = kind
    this.status = status
  }
}

const AMBIGUOUS_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])

function scrub(text, apiKey) {
  const raw = String(text || "")
  if (!apiKey) return raw
  return raw.split(apiKey).join("[redacted]")
}

export function createClient(cfg, fetchImpl = globalThis.fetch) {
  async function call(path, { method = "GET", body, signal, timeoutMs } = {}) {
    const timer = new AbortController()
    const timerId = setTimeout(() => timer.abort(), timeoutMs || cfg.timeoutMs)
    const onAbort = () => timer.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    let response
    try {
      response = await fetchImpl(cfg.baseUrl + path, {
        method,
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + cfg.apiKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timer.signal,
      })
    } catch (error) {
      const timedOut = error.name === "AbortError" || timer.signal.aborted
      throw new OvError(
        timedOut
          ? "ov-codex-memory: OpenViking request timed out or was cancelled"
          : "ov-codex-memory: " + (String(error.message || "").includes("redirect")
            ? "OpenViking redirected; redirects are refused"
            : "OpenViking request failed before a definite response"),
        timedOut ? "timeout" : "ambiguous",
      )
    } finally {
      clearTimeout(timerId)
      signal?.removeEventListener("abort", onAbort)
    }
    let text = ""
    try {
      text = await response.text()
    } catch {
      throw new OvError("ov-codex-memory: OpenViking response could not be read", "ambiguous", response.status)
    }
    if (!response.ok) {
      const kind = AMBIGUOUS_STATUS.has(response.status) ? "ambiguous" : "rejected"
      throw new OvError("ov-codex-memory: OpenViking HTTP " + response.status, kind, response.status)
    }
    if (!text) return {}
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.result !== undefined && parsed.status === "ok") {
        return parsed.result
      }
      return parsed
    } catch {
      throw new OvError("ov-codex-memory: OpenViking returned a malformed success body", "ambiguous", response.status)
    }
  }

  return {
    find(query, signal) {
      return call("/api/v1/search/find", { method: "POST", body: { query, limit: 5 }, signal })
    },
    ensureSession(sessionId, signal) {
      return call("/api/v1/sessions", {
        method: "POST",
        body: { session_id: sessionId, auto_commit_policy: null },
        signal,
      }).catch((error) => {
        if (error.status === 409) return { session_id: sessionId }
        throw error
      })
    },
    addPair(sessionId, messages, signal) {
      return call("/api/v1/sessions/" + encodeURIComponent(sessionId) + "/messages/batch", {
        method: "POST",
        body: { messages },
        signal,
      })
    },
    commit(sessionId, signal) {
      return call("/api/v1/sessions/" + encodeURIComponent(sessionId) + "/commit", {
        method: "POST",
        body: { keep_recent_count: 0 },
        signal,
      })
    },
    getTask(taskId, signal) {
      return call("/api/v1/tasks/" + encodeURIComponent(taskId), { signal })
    },
    scrub(text) {
      return scrub(text, cfg.apiKey)
    },
  }
}
