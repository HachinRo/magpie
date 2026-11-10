import { deviceOf, idOf, textOf } from "./ids.mjs"
import { stopResult, userPromptSubmit } from "./codex.mjs"
import { recallBlock } from "./recall-text.mjs"
import { ovSessionId, sourceId } from "./store.mjs"

const MAX_TEXT = 16000

function pair(args) {
  return {
    device: deviceOf(args.device),
    sessionId: idOf(args.session_id, "session_id"),
    turnId: idOf(args.turn_id, "turn_id"),
  }
}

function contains(body, id) {
  return JSON.stringify(body ?? "").includes(id)
}

/**
 * Remember the prompt, then search. A search failure still leaves the
 * prompt stored so a later capture can pair it. Recall text is bounded.
 */
export async function hookContext(store, ov, args, signal) {
  const who = pair(args)
  const prompt = textOf(args.query, "query", MAX_TEXT)
  if (!prompt) {
    return userPromptSubmit("", "ov-codex-memory: empty prompt, nothing stored and nothing searched")
  }
  await store.savePrompt(who.device, who.sessionId, who.turnId, prompt)
  try {
    const found = await ov.find(prompt.slice(0, 4000), signal)
    return userPromptSubmit(recallBlock(found))
  } catch (error) {
    return userPromptSubmit("", "ov-codex-memory: recall failed; the prompt was saved for capture. " + clip(error))
  }
}

function clip(error) {
  return String(error?.message || "failed").replace(/\s+/g, " ").slice(0, 240)
}

/**
 * Capture the user prompt stored for this device, session and turn together
 * with the assistant text. Assistant-only input is not written.
 * archived:true is phase 1. task status is a separate read.
 */
export async function hookCapture(store, ov, args, signal) {
  const who = pair(args)
  const assistant = textOf(args.assistant, "assistant", MAX_TEXT)
  if (!assistant) {
    return stopResult("ov-codex-memory: no assistant text, so this turn was not captured")
  }
  const promptRow = await store.readPrompt(who.device, who.sessionId, who.turnId)
  if (!promptRow || typeof promptRow.prompt !== "string" || !promptRow.prompt.trim()) {
    return stopResult("ov-codex-memory: no prompt stored for this device, session_id and turn_id. The assistant text was not captured. hook_context must run first with the same three values.")
  }
  const ovSession = ovSessionId(who.device, who.sessionId)
  const userSource = sourceId(who.device, who.sessionId, who.turnId, "user")
  const assistantSource = sourceId(who.device, who.sessionId, who.turnId, "assistant")
  return store.lockTurn(who.device, who.sessionId, who.turnId, async (current, write) => {
    if (current && (current.phase === "accepted" || current.phase === "settled")) {
      return stopResult(settledMessage(current))
    }
    let row = current && current.phase === "committing" ? current : {
      v: 1,
      ...who,
      ovSessionId: ovSession,
      phase: "committing",
      prompt: promptRow.prompt,
      assistant,
      appended: false,
      userSource,
      assistantSource,
      commit: null,
    }
    if (row.prompt !== promptRow.prompt) row = { ...row, prompt: promptRow.prompt }
    row.assistant = assistant
    await write(row)
    if (!row.appended) {
      const existing = await ov.getSession(ovSession, signal).catch(() => null)
      const already = contains(existing, userSource) && contains(existing, assistantSource)
      if (!already) {
        await ov.ensureSession(ovSession, signal)
        await ov.addPair(ovSession, [
          { role: "user", content: row.prompt, turn_id: who.turnId, source_message_ids: [userSource] },
          { role: "assistant", content: assistant, turn_id: who.turnId, source_message_ids: [assistantSource] },
        ], signal)
      }
      row = { ...row, appended: true }
      await write(row)
    }
    const commit = await ov.commit(ovSession, signal)
    const archived = commit?.archived === true
    const taskId = typeof commit?.task_id === "string" && commit.task_id ? commit.task_id : null
    if (archived) {
      row = { ...row, phase: "accepted", commit: { status: commit.status || "accepted", archived: true, taskId, extractionComplete: false } }
      await write(row)
      const task = taskId
        ? "Extraction task " + taskId + " is not finished."
        : "No extraction task id was returned, so extraction is not confirmed."
      return stopResult("ov-codex-memory: archive accepted. " + task)
    }
    if (row.appended && commit?.archived === false && commit?.reason === "no_messages") {
      row = { ...row, phase: "settled", commit: { status: "skipped", archived: false, taskId: null, reason: "no_messages", extractionComplete: false } }
      await write(row)
      return stopResult("ov-codex-memory: commit returned no_messages after the pair was already sent. It was not sent again. archived is false; there is no extraction task.")
    }
    row = { ...row, phase: "committing", commit: { status: commit?.status || "unknown", archived: false, taskId, reason: commit?.reason || "not-archived", extractionComplete: false } }
    await write(row)
    return stopResult("ov-codex-memory: commit did not archive (archived is false). Nothing was marked extracted. Retry the Stop hook to try again.")
  })
}

function settledMessage(row) {
  const commit = row.commit || {}
  if (commit.archived === true && commit.taskId) {
    const done = commit.extractionComplete === true ? "finished" : "not finished"
    return "ov-codex-memory: this turn was already archived. Extraction task " + commit.taskId + " is " + done + ". It was not committed again."
  }
  return "ov-codex-memory: this turn was already settled (archived " + String(commit.archived === true) + "). It was not committed again."
}

export async function hookTask(store, ov, args, signal) {
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
