// Loopback OpenViking HTTP. Redirects are errors. The key is not copied
// into errors, logs, or tool results.

function scrub(text, apiKey) {
  const raw = String(text || "")
  const clipped = raw.length > 300 ? raw.slice(0, 300) : raw
  if (!apiKey) return clipped
  return clipped.split(apiKey).join("[redacted]")
}

export function createClient(cfg, fetchImpl = globalThis.fetch) {
  async function call(path, { method = "GET", body, signal, timeoutMs } = {}) {
    const timer = new AbortController()
    const timerId = setTimeout(() => timer.abort(), timeoutMs || cfg.timeoutMs)
    const onAbort = () => timer.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      const response = await fetchImpl(cfg.baseUrl + path, {
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
      const text = await response.text()
      let parsed = null
      if (text) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = null
        }
      }
      if (!response.ok) {
        throw new Error("ov-codex-memory: OpenViking HTTP " + response.status + " " + scrub(text, cfg.apiKey))
      }
      if (parsed && typeof parsed === "object" && parsed.result !== undefined && parsed.status === "ok") {
        return parsed.result
      }
      return parsed
    } catch (error) {
      if (error.name === "AbortError" || timer.signal.aborted) {
        throw new Error("ov-codex-memory: OpenViking request timed out or was cancelled")
      }
      if (String(error.message || "").includes("redirect")) {
        throw new Error("ov-codex-memory: OpenViking redirected; redirects are refused")
      }
      throw new Error(scrub(error.message, cfg.apiKey))
    } finally {
      clearTimeout(timerId)
      signal?.removeEventListener("abort", onAbort)
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
        if (String(error.message).includes("HTTP 409")) return { session_id: sessionId }
        throw error
      })
    },
    getSession(sessionId, signal) {
      return call("/api/v1/sessions/" + encodeURIComponent(sessionId), { signal })
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
  }
}
