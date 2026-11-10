import { deviceOf, idOf, textOf } from "./ids.mjs"
import { stopResult, userPromptSubmit } from "./codex.mjs"
import { planRecall, queryHash } from "./recall-query.mjs"
import { byScore, hitsFrom, renderRecall } from "./recall-text.mjs"
import { ovSessionId } from "./store.mjs"

const MAX_TEXT = 16000
const TERMINAL = new Set(["accepted", "settled", "ambiguous"])

function pair(args) {
  return {
    device: deviceOf(args.device),
    sessionId: idOf(args.session_id, "session_id"),
    turnId: idOf(args.turn_id, "turn_id"),
  }
}

function clip(error) {
  return String(error?.message || "failed").replace(/\s+/g, " ").slice(0, 180)
}

function kindOf(error) {
  if (error?.kind === "rejected" || error?.kind === "ambiguous" || error?.kind === "timeout") return error.kind
  return "ambiguous"
}

function promptMatches(row, who) {
  return !!row
    && row.device === who.device
    && row.sessionId === who.sessionId
    && row.turnId === who.turnId
    && typeof row.prompt === "string"
    && row.prompt.trim().length > 0
}

function withOneBackup(primary, backup) {
  const ranked = byScore(primary)
  const seen = new Set(ranked.map((hit) => hit.uri).filter(Boolean))
  for (const hit of byScore(backup)) {
    if (hit.uri && seen.has(hit.uri)) continue
    return ranked.concat(hit)
  }
  return ranked
}

function redactQueries(message, queries) {
  let out = message
  const secrets = queries.filter((query) => typeof query === "string" && query.length >= 8)
  secrets.sort((a, b) => b.length - a.length)
  for (const query of secrets) out = out.split(query).join("[query]")
  return out.slice(0, 900)
}

async function runFind(ov, stage, signal) {
  const qhash = queryHash(stage.query)
  try {
    const body = await ov.find(stage.query, stage.options, signal)
    const hits = hitsFrom(body, stage.bucket)
    return { name: stage.name, ok: true, kind: "ok", count: hits.length, hits, qhash }
  } catch (error) {
    return { name: stage.name, ok: false, kind: kindOf(error), count: 0, hits: [], qhash }
  }
}

/**
 * Remember the original prompt, then read OpenViking with find().
 * The stored prompt is not the retrieval suffix. Search failure still
 * leaves a matching prompt stored when there is room.
 */
export async function hookContext(store, ov, args, signal) {
  const who = pair(args)
  const prompt = textOf(args.query, "query", MAX_TEXT)
  if (!prompt) {
    return userPromptSubmit("", "ov-codex-memory: empty prompt, nothing stored and nothing searched")
  }
  const saved = await store.savePrompt(who.device, who.sessionId, who.turnId, prompt)
  const plan = planRecall(prompt)
  // Every find starts together. The wait is one OpenViking timeout, not
  // one timeout per call. A nonempty focus result does not cancel the
  // full-prompt memory find.
  const ran = await Promise.all(plan.stages.map((stage) => runFind(ov, stage, signal)))
  const memory = ran.find((stage) => stage.name === "memory")
  const backup = ran.find((stage) => stage.name === "memory-full") || {
    name: "memory-full", ok: true, kind: "na", count: 0, hits: [], qhash: "",
  }
  const skill = ran.find((stage) => stage.name === "skill")
  const resource = ran.find((stage) => stage.name === "resource")
  const memoryHits = memory.ok && memory.hits.length
    ? withOneBackup(memory.hits, backup.hits)
    : backup.hits
  const rendered = renderRecall({
    memories: byScore(memoryHits).slice(0, 5),
    skills: byScore(skill.hits).slice(0, 2),
    resources: byScore(resource.hits).slice(0, 2),
  })
  const stages = [memory, backup, skill, resource]
  const attempted = stages.filter((stage) => stage.kind !== "skip" && stage.kind !== "na")
  const anyOk = attempted.some((stage) => stage.ok)
  const anyBad = attempted.some((stage) => !stage.ok)
  let head = "ov-codex-memory: recall"
  if (!anyOk && anyBad) head = "ov-codex-memory: recall failed; the prompt was saved for capture."
  else if (anyOk && anyBad) head = "ov-codex-memory: recall partial"
  const summary = stages.map((stage) => stage.name + ":" + stage.kind + ":" + stage.count).join(" ")
  const hashes = []
  for (const stage of stages) {
    if (stage.kind === "skip" || stage.kind === "na" || !stage.qhash) continue
    if (!hashes.includes(stage.qhash)) hashes.push(stage.qhash)
  }
  const uris = rendered.uris.slice(0, 5).map((uri) => uri.replaceAll(",", "%2C")).join(",")
  let message = head + " " + summary + " focus:" + (plan.focus ? "1" : "0") + " qh:" + hashes.join(",")
  if (uris) message += " uri:" + uris
  if (!saved.stored && saved.reason === "full") {
    message = "ov-codex-memory: prompt store is full, so this prompt was not saved and will not be captured. " + message
  }
  const queries = plan.stages.map((stage) => stage.query)
  message = redactQueries(message, queries)
  if (typeof ov.scrub === "function") message = ov.scrub(message).slice(0, 900)
  return userPromptSubmit(rendered.text, message)
}

/**
 * At-most-once capture. OpenViking message append and commit are not
 * idempotent. A dispatch flag is made durable before the request. If the
 * process stops after that flag and before a definite response, the turn
 * is marked ambiguous and is not sent again.
 */
export async function hookCapture(store, ov, args, signal) {
  const who = pair(args)
  const assistant = textOf(args.assistant, "assistant", MAX_TEXT)
  if (!assistant) {
    return stopResult("ov-codex-memory: no assistant text, so this turn was not captured")
  }
  if (signal?.aborted) {
    return stopResult("ov-codex-memory: capture was cancelled before anything was sent")
  }
  const ovSession = ovSessionId(who.device, who.sessionId)
  try {
    return await store.lockTurn(who.device, who.sessionId, who.turnId, async (current, write) => {
      if (current && TERMINAL.has(current.phase)) return stopResult(terminalMessage(current, ovSession))
      const resumed = current && (current.phase === "appended" || current.phase === "append-dispatched" || current.phase === "commit-dispatched")
      let promptRow = null
      if (!resumed) {
        promptRow = await store.readPrompt(who.device, who.sessionId, who.turnId)
        if (!promptMatches(promptRow, who)) {
          return stopResult("ov-codex-memory: no matching prompt for this device, session_id and turn_id. The assistant text was not captured.")
        }
      }
      let row = current && current.phase ? { ...current } : {
        v: 2,
        ...who,
        ovSessionId: ovSession,
        phase: "armed",
        prompt: promptRow.prompt,
        assistant,
      }
      if (row.phase === "armed") {
        row.prompt = promptRow.prompt
        row.assistant = assistant
        await write(row)
        try {
          await ov.ensureSession(ovSession, signal)
        } catch (error) {
          return stopResult("ov-codex-memory: session was not prepared (" + kindOf(error) + "). Nothing was appended. " + clip(error))
        }
        if (signal?.aborted) {
          return stopResult("ov-codex-memory: capture was cancelled before the append. Nothing was appended.")
        }
        row = { ...row, phase: "append-dispatched", prompt: promptRow.prompt, assistant }
        await write(row)
        try {
          await ov.addPair(ovSession, [
            { role: "user", content: row.prompt, turn_id: who.turnId },
            { role: "assistant", content: assistant, turn_id: who.turnId },
          ], signal)
        } catch (error) {
          if (kindOf(error) === "rejected") {
            row = { ...row, phase: "armed" }
            await write(row)
            return stopResult("ov-codex-memory: OpenViking rejected the append. It was not marked captured. " + clip(error))
          }
          row = wipe({ ...row, phase: "ambiguous", reason: "append-outcome-unknown" })
          await write(row)
          return stopResult(ambiguousMessage(ovSession, "append"))
        }
        row = { ...row, phase: "appended" }
        await write(row)
      }
      if (row.phase === "append-dispatched") {
        row = wipe({ ...row, phase: "ambiguous", reason: "append-outcome-unknown" })
        await write(row)
        return stopResult(ambiguousMessage(ovSession, "append"))
      }
      if (row.phase === "appended") {
        row = { ...row, phase: "commit-dispatched" }
        await write(wipe(row))
        let commit
        try {
          commit = await ov.commit(ovSession, signal)
        } catch (error) {
          row = wipe({ ...row, phase: "ambiguous", reason: "commit-outcome-unknown" })
          await write(row)
          return stopResult(ambiguousMessage(ovSession, "commit"))
        }
        const definite = commit && typeof commit === "object" && !Array.isArray(commit) && typeof commit.archived === "boolean"
        if (!definite) {
          row = wipe({ ...row, phase: "ambiguous", reason: "commit-response-malformed" })
          await write(row)
          return stopResult(ambiguousMessage(ovSession, "commit"))
        }
        if (commit.archived === true) {
          const taskId = typeof commit.task_id === "string" && commit.task_id ? commit.task_id : null
          row = wipe({
            ...row,
            phase: "accepted",
            commit: { status: commit.status || "accepted", archived: true, taskId, extractionComplete: false },
          })
          await write(row)
          const task = taskId
            ? "Extraction task " + taskId + " is not finished."
            : "No extraction task id was returned, so extraction is not confirmed."
          return stopResult("ov-codex-memory: archive accepted. " + task)
        }
        row = wipe({
          ...row,
          phase: "settled",
          commit: { status: commit.status || "skipped", archived: false, taskId: null, reason: commit.reason || "not-archived", extractionComplete: false },
        })
        await write(row)
        return stopResult("ov-codex-memory: commit returned archived false (" + (commit.reason || "not-archived") + "). It was not committed again and nothing was marked extracted.")
      }
      if (row.phase === "commit-dispatched") {
        row = wipe({ ...row, phase: "ambiguous", reason: "commit-outcome-unknown" })
        await write(row)
        return stopResult(ambiguousMessage(ovSession, "commit"))
      }
      return stopResult("ov-codex-memory: this turn is in an unknown local state and was not sent")
    })
  } catch (error) {
    if (error.code === "LEDGER_FULL") {
      return stopResult("ov-codex-memory: capture ledger is full. This turn was not sent.")
    }
    throw error
  }
}

function wipe(row) {
  const next = { ...row }
  delete next.prompt
  delete next.assistant
  return next
}

function ambiguousMessage(ovSession, step) {
  return "ov-codex-memory: " + step + " outcome is unknown for OpenViking session " + ovSession + ". It was not retried. Reconcile that session by hand. This plugin is at-most-once, not exactly-once."
}

function terminalMessage(row, ovSession) {
  if (row.phase === "ambiguous") return ambiguousMessage(ovSession, row.reason || "capture")
  const commit = row.commit || {}
  if (row.phase === "accepted" && commit.archived === true) {
    const task = commit.taskId
      ? "Extraction task " + commit.taskId + " was not checked again."
      : "No extraction task id was stored."
    return "ov-codex-memory: this turn was already archived. " + task + " It was not committed again."
  }
  return "ov-codex-memory: this turn was already settled with archived false. It was not committed again."
}

export async function hookTask(_store, ov, args, signal) {
  const taskId = idOf(args.task_id, "task_id")
  const task = await ov.getTask(taskId, signal)
  const status = typeof task?.status === "string" ? task.status : "unknown"
  return JSON.stringify({
    task_id: taskId,
    status,
    extractionComplete: status === "completed",
    note: "archived acceptance is recorded on the turn, not by this status. completed is the extraction task only.",
  })
}
