// The plugin calls OpenViking only on this computer. A public or LAN URL
// is refused so the package cannot be aimed at an exposed OpenViking port.

export function assertLoopback(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error("ov-codex-memory: OpenViking URL is not a URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ov-codex-memory: OpenViking URL must be http or https")
  }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("ov-codex-memory: OpenViking URL must be loopback (127.0.0.1, localhost, or ::1)")
  }
  if (url.username || url.password) {
    throw new Error("ov-codex-memory: OpenViking URL must not carry a user or password")
  }
  return url.origin
}
