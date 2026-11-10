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
  async function call(path, { method = "GET", body, signal, timeoutMs, maxChars } = {}) {
    const timer = new AbortController()
    const timerId = setTimeout(() => timer.abort(), timeoutMs || cfg.timeoutMs)
    const onAbort = () => timer.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    let response
    try {
      const headers = {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      }
      // Official loopback dev mode has an empty api_key. Sending
      // "Bearer " or "Bearer null" would be a fake credential.
      if (typeof cfg.apiKey === "string" && cfg.apiKey) headers.Authorization = "Bearer " + cfg.apiKey
      response = await fetchImpl(cfg.baseUrl + path, {
        method,
        redirect: "error",
        headers,
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
    if (text.length > (maxChars || 2000000)) {
      throw new OvError("ov-codex-memory: OpenViking response was too large", "rejected", response.status)
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
    // Read-only vector find. Options are an allow-list: limit, target_uri,
    // and context_type. read_content, session_id, and search mode are not
    // forwarded. A second argument that is an AbortSignal is the signal.
    find(query, options, signal) {
      if (options && typeof options === "object" && typeof options.aborted === "boolean" && signal === undefined) {
        signal = options
        options = undefined
      }
      const body = { query: String(query ?? "").slice(0, 4000), limit: 5 }
      if (options && typeof options === "object") {
        if (Number.isInteger(options.limit) && options.limit >= 1 && options.limit <= 10) body.limit = options.limit
        if (typeof options.target_uri === "string" && options.target_uri) body.target_uri = options.target_uri
        if (typeof options.context_type === "string" && options.context_type) body.context_type = options.context_type
      }
      return call("/api/v1/search/find", { method: "POST", body, signal })
    },
    // L2 file body. File URIs only; the server rejects a directory. raw is
    // not set, so the default sanitizer stays on. The line limit and the
    // response cap keep one read from becoming the whole hook budget.
    readMemory(uri, signal) {
      const path = "/api/v1/content/read?uri=" + encodeURIComponent(uri) + "&offset=0&limit=40"
      return call(path, {
        method: "GET",
        signal,
        timeoutMs: Math.min(cfg.timeoutMs, 2000),
        maxChars: 12000,
      })
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
