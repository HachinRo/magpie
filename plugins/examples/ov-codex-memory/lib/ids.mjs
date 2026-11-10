// Device is a label the hook file sets. It is not a credential and it does
// not authenticate the caller. The gateway key's MCP allowlist does that.

const DEVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function deviceOf(value) {
  if (typeof value !== "string" || !DEVICE.test(value)) {
    throw new Error("ov-codex-memory: device must be 1-64 letters, digits, dots, underscores or hyphens, set in the hook file")
  }
  return value
}

export function idOf(value, name) {
  if (typeof value !== "string") throw new Error(`ov-codex-memory: ${name} must be a string`)
  const text = value.trim()
  if (!text || text.length > 128 || /[\u0000-\u001f\\/]/.test(text)) {
    throw new Error(`ov-codex-memory: ${name} must be one line of at most 128 characters`)
  }
  return text
}

export function textOf(value, name, max) {
  if (value == null) return ""
  if (typeof value !== "string") throw new Error(`ov-codex-memory: ${name} must be a string`)
  const text = value.trim()
  if (text.length <= max) return text
  return text.slice(0, max)
}
