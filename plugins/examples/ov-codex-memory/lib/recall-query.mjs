// Retrieval queries for OpenViking 0.5.4 find(). No model call.
//
// search(mode=context) is not used. In 0.5.4 it still vector-searches the
// query it is given (the same path as find), it rejects target_uri, and
// query_expansion "auto" plus rewrite can call the server's planner. This
// plugin does not enable that.
//
// A long prompt is split only when a short suffix is structurally separate
// from a much larger prefix: a final question, or, failing that, a short
// last line after at least two earlier lines. Code fences, a short prompt,
// a long suffix, and an unclosed fence keep the whole prompt. The stored
// prompt is never this suffix.

import { createHash } from "node:crypto"

const MIN_PROMPT = 420
const MIN_PREFIX = 180
const MIN_FOCUS = 8
const MAX_FOCUS = 400
const MAX_RATIO = 0.4
const MEMORY_URI = "viking://~/memories"

export function queryHash(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 16)
}

function fenceLine(line) {
  return /^\s*(?:```|~~~)/.test(line)
}

function hasFenceLine(text) {
  return text.split("\n").some(fenceLine)
}

function insideFence(text, index) {
  const lines = text.slice(0, index).split("\n")
  let open = false
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (fenceLine(lines[i])) open = !open
  }
  return open
}

function lastLineIsShort(text, focus) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean)
  if (lines.length < 2 || lines[lines.length - 1] !== focus) return false
  // The suffix has to be at most half of every earlier line. Equal
  // paragraphs, short code lines, and a long final question stay whole.
  return lines.slice(0, -1).every((line) => focus.length * 2 <= line.length)
}

function accept(text, candidate) {
  const focus = String(candidate || "").trim()
  if (focus.length < MIN_FOCUS || focus.length > MAX_FOCUS) return ""
  if (!text.endsWith(focus)) return ""
  const prefix = text.length - focus.length
  if (prefix < MIN_PREFIX) return ""
  if (focus.length / text.length > MAX_RATIO) return ""
  if (!lastLineIsShort(text, focus)) return ""
  if (!/\p{L}/u.test(focus)) return ""
  if (/^(?:```|[ \t])/.test(focus)) return ""
  if (/[{;\\,]$/.test(focus)) return ""
  return focus
}

function questionSuffix(text) {
  let end = -1
  for (const mark of ["?", "？", "؟"]) {
    const at = text.lastIndexOf(mark)
    if (at > end) end = at
  }
  if (end < 0 || insideFence(text, end)) return ""
  const nl = text.lastIndexOf("\n", end)
  return text.slice(nl >= 0 ? nl + 1 : 0, end + 1).trim()
}

function shortLastLine(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean)
  if (lines.length < 3) return ""
  const last = lines[lines.length - 1]
  const at = text.lastIndexOf(last)
  if (at < 0 || insideFence(text, at)) return ""
  return last
}

function questionBeforeLastLine(text) {
  const lines = text.split("\n")
  let start = 0
  let lastStart = 0
  for (const line of lines) {
    if (line.trim()) lastStart = start
    start += line.length + 1
  }
  const head = text.slice(0, lastStart)
  return ["?", "？", "؟"].some((mark) => head.includes(mark))
}

/**
 * Short retrieval suffix, or "" when the whole prompt should be searched.
 * A question that is not the final line is not replaced by a later
 * instruction line. A fenced block is not split.
 */
export function focusOf(prompt) {
  const text = String(prompt || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
  if (text.length < MIN_PROMPT || hasFenceLine(text)) return ""
  const asked = accept(text, questionSuffix(text))
  if (asked) return asked
  if (questionBeforeLastLine(text)) return ""
  return accept(text, shortLastLine(text))
}

function stage(name, query, bucket, options) {
  return { name, query, bucket, options }
}

/**
 * Read-only find plan. Memory is scoped to viking://~/memories.
 * Skills and resources are separate finds on the same primary query.
 * When a focus exists, the full prompt is a second memory find started
 * at the same time. A nonempty focus result does not cancel it. It is
 * not a second planner.
 */
export function planRecall(prompt) {
  const stored = String(prompt || "").trim()
  const full = stored.slice(0, 4000)
  const focus = focusOf(stored)
  const primary = focus || full
  const stages = [
    stage("memory", primary, "memories", {
      limit: 5,
      target_uri: MEMORY_URI,
      context_type: "memory",
    }),
  ]
  if (focus && focus !== full) {
    stages.push(stage("memory-full", full, "memories", {
      limit: 5,
      target_uri: MEMORY_URI,
      context_type: "memory",
    }))
  }
  stages.push(
    stage("skill", primary, "skills", { limit: 2, context_type: "skill" }),
    stage("resource", primary, "resources", { limit: 2, context_type: "resource" }),
  )
  return { focus, full, primary, stages }
}
