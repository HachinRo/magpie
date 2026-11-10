# ov-codex-memory

Tools-only companion for this Magpie fork. Codex on another computer recalls
and captures through the Magpie MCP hub it is already signed in to. The plugin
runs on the computer where OpenViking listens on loopback, and it calls that
loopback itself. It does not register gateway hooks, so a model request is not
intercepted and cannot re-enter these tools by itself.

The existing OpenViking Magpie plugin and its `find`, `read`, and `remember`
tools are not modified. These tools are `hook_context`, `hook_capture`, and
`hook_task`. On the hub they are named `ov-codex-memory__hook_context`,
`ov-codex-memory__hook_capture`, and `ov-codex-memory__hook_task` when the
plugin's library server keeps this folder's name.

## What it does

`hook_context` runs from Codex `UserPromptSubmit`. It stores the prompt under
the device label, `session_id`, and `turn_id`, then reads OpenViking with
`POST /api/v1/search/find` only. It returns only JSON Codex accepts for that event:

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<ov-codex-context>\n...\n</ov-codex-context>"}}
```

Recalled text is untrusted data inside that delimiter. The body is at most
2000 characters, and each hit has its own cap, so one long abstract cannot
crowd out a later one. Memories, skills, and resources are separate
sections. A hit shows its `viking://` uri and its abstract. Overview and
file content are not copied into the block. The model can open a uri with
the existing OpenViking read tool. This plugin does not read those files
and does not run commands found in notes. Tags that would close the
delimiter are neutralized. The search body is not returned raw: Codex
rejects unexpected fields (`deny_unknown_fields` on
`UserPromptSubmitCommandOutputWire`).

The memory find is scoped to `viking://~/memories` with `context_type`
`memory` and `limit` 5. Skill and resource finds use the same primary
query, limits 2, and their own `context_type`, with no memory scope mixed
in. A short prompt, a single paragraph, a fenced block with short lines,
and a balanced multiline question are sent whole. A longer prompt is also
searched as its final line only when that line is a question or a short
last line, and it is at most half as long as every earlier line. That is a
structural split, not a model and not a language-specific name list. The
stored prompt is never replaced by that line. If the short find returns no
memories or fails, one memory find of the full prompt (first 4000
characters) runs as a fallback. `search`, including `mode=context`, is not
called: on 0.5.4 that mode still vector-searches the query it is given, it
rejects `target_uri`, and session expansion or rewrite can call the
server's planner. Those model calls stay off.

`systemMessage` records stage, status, counts, whether a focus query was
used, a 16-character hash of each query that was sent, and the injected
uris. It does not include the query text, abstracts, or response bodies.
The count is how many hits the find returned. The uri list is what was
injected after the per-hit budget.

`hook_capture` runs from Codex `Stop`. It writes the stored prompt and the
assistant text into one OpenViking session, then commits with
`keep_recent_count: 0`. It returns only Stop fields. It never sets
`decision: "block"`, which would continue the turn. `archived: true` is phase 1
(the archive was accepted). The extraction task is separate. `hook_task` reads
`GET /api/v1/tasks/{task_id}`; `extractionComplete` is true only when that task
status is `completed`.

If no prompt was stored for that device, session, and turn, the assistant text
is not written. The Stop result says so.

## Trust

The device string is a label you type in the hook file (`win-codex`). It
separates session ids. It does not authenticate the caller. Anyone whose
gateway key is allowed to call these tools uses the OpenViking identity in
this computer's `ovcli.conf`. That is the same shared owner memory the hub's
existing OpenViking tools already use. This plugin does not invent a second
user, and it does not see the gateway key.

A key whose MCP list is empty may call every hub tool, which is Magpie's
existing rule. A key with an allowlist must include this server, or these
tool names, or the call is refused by Magpie. This package does not change
that list.

## Install

On the computer that already runs Magpie and loopback OpenViking, add this
folder as a plugin. Do not turn off the existing OpenViking plugin, and do
not publish or change its tools.

```sh
magpie plugin add /absolute/path/to/plugins/examples/ov-codex-memory
```

Leave it on. The plugin host loads tools from `index.mjs`. There is no
`magpie.hooks` entry.

OpenViking's URL stays in `~/.openviking/ovcli.conf` (or
`OPENVIKING_CLI_CONFIG_FILE`) on that computer. The URL must be loopback:
`127.0.0.1`, `localhost`, or `::1`. A LAN or public URL is refused even when
`api_key` is empty. Redirects are refused.

An empty, missing, or JSON null `api_key` is the official no-key loopback
client (OpenViking `auth_mode: dev` accepts this, and the official Magpie
plugin omits `Authorization` when the key is empty). This plugin does the
same: no `Authorization` header, and not `Bearer `, `Bearer null`, or a
whitespace token. A non-empty key is trimmed and sent only as
`Authorization: Bearer <key>`. A non-string key, or one with a line break,
is refused without the value being copied into the error. Do not put a
Magpie gateway key in the plugin options.

Optional plugin options:

```json
{ "timeoutMs": 8000 }
```

`timeoutMs` is an integer from 100 to 15000. The default is 8000. State is
under `dataDir` or `~/.openviking/ov-codex-memory/`. That directory must be a
real directory, not a symlink. It is chmod 0700, and the files inside are
0600. `ovcli.conf` must be a regular file of at most 64KiB. A symlink config
is refused.

## Codex hooks

Checked by reading `openai/codex` `main`, not by running Codex.

- `mcp_tool` execution is the behavior in PR 38705 (merged 2026-08-15). PR
  37363 only parsed the handler and skipped it. A build that skips will not
  recall or capture.
- `hooks/codex.hooks.json` uses the published handler fields: `type`,
  `server`, `tool`, `input`, `timeout`, and `statusMessage`.
- Both `UserPromptSubmitCommandInput` and `StopCommandInput` are serialized
  with serde's default names (no `rename_all`). The event JSON therefore has
  `session_id`, `turn_id`, and, on submit, `prompt`. Stop has
  `last_assistant_message` (`NullableString`: a string or `null`) and does
  not have `prompt`. The sample's `${turn_id}` is the same field name on
  both events. This source check does not prove a live turn puts the same
  value in both events. If it does not, capture finds no prompt and does not
  write the assistant text.
- A missing placeholder fails in Codex before this plugin is called. A null
  `last_assistant_message` arrives as null and is not captured.
- User and project hooks do not run for Codex's internal memory-consolidation
  Stop (`runs_for_memory_consolidation` is false for those sources). This
  sample does not read `stop_hook_active`. It does not invent a host signal
  that two events are one turn beyond the shared field names above.
- `SessionEnd` cannot run `mcp_tool`. Do not point `hook_task` at a hook.

Copy `hooks/codex.hooks.json` into Codex's user hooks. Replace the server name
with the hub entry already in Codex's config. Set `device` to a label for
this machine. Do not add an `Authorization` header or a copied key. The hook
uses the connection Codex already has. `features.hooks` must not be false.

## DSH

Not implemented. The DSH OpenViking plugin calls OpenViking HTTP directly and
starts its own stdio proxy. It has no sanctioned call into an MCP server DSH
is already connected to. This package does not read DSH's config and does not
copy a gateway key into an environment variable. A DSH adapter would need that
host API, or a separate credential the user configures on purpose. Neither is
this plugin.

## Delivery

OpenViking append and commit are not idempotent. `source_message_ids` are
provenance, not a supported idempotency key, so this plugin does not retry
from a session read. Capture is at-most-once, not exactly-once.

The local phase is fsynced before the request (`append-dispatched`, then
`commit-dispatched`). A crash, timeout, abort, or HTTP 408/409/429/5xx after
that flag leaves the turn `ambiguous`. A later Stop does not append or commit
again. The request may never have reached OpenViking, or it may have landed.
Reconcile that OpenViking session by hand. A definite HTTP 4xx on append
(other than those statuses) returns the turn to `armed` and a later Stop may
send once more. A commit body without a boolean `archived` is ambiguous and
is not repeated. `archived: false` is settled and is not repeated.
`archived: true` is not extraction success.

An abort or error before the dispatch flag does not append. Assistant text
from a failed Stop is not marked captured.

## One read-only check

Do this on the computer where OpenViking is already listening, only when a
person asks for it. It does not call `hook_context`, so it does not write
the plugin's prompt store. It does not create a session, append, commit, or
extract. With an empty `api_key`, send no `Authorization` header.

Use the question span, not a long instruction preamble. A canned fixture in
the tests is not this check, and this check is not a new Codex conversation.

```sh
curl -sS -X POST http://127.0.0.1:1933/api/v1/search/find \
  -H 'Content-Type: application/json' \
  -d '{"query":"QUESTION SPAN ONLY","limit":5,"target_uri":"viking://~/memories","context_type":"memory"}'
```

Replace `QUESTION SPAN ONLY` with the short question. Read the `memories`
uris and abstracts. Do not treat a hit as proof of what an earlier hook
request returned.

## Limits

- Recall is scoped `find`, not `search` and not context mode. Context mode
  would not by itself fix an instruction-heavy query, because 0.5.4 still
  embeds the query it is given.
- Pairing is the device label plus `session_id` plus `turn_id`. The stored
  prompt record must carry those same three values. A mismatch does not
  capture.
- A lock is taken only when its pid is dead, or when it is empty and at least
  a second old. A live pid is never stolen. If that pid is reused by an
  unrelated process, the lock stays until that process exits.
- At most 200 prompt files. Prompts for turns that are not finished are kept.
  The capture ledger keeps up to 2000 turn records and then refuses new
  turns instead of deleting old ones.
- Prompt and assistant text are stored up to 16000 characters each, and are
  removed from the local record once the turn is terminal.
- This is a Codex prototype. It is not DSH automatic memory and it does not
  cover every client on the LAN.
- The plugin does not route models and does not change Cheap First or local
  embeddings. Extraction, if OpenViking schedules it, uses whatever model
  OpenViking is already configured to call on this computer.

## Tests

This package's install archive includes `test/plugin.test.mjs`. From the
extracted package directory:

```sh
node --test test/plugin.test.mjs
```

The same file in the git tree is
`plugins/examples/ov-codex-memory/test/plugin.test.mjs`. The tests use a fake
OpenViking client and one local hung HTTP server. They do not call a real
OpenViking, a real Codex, or a live Magpie. A fixture that returns a chosen
fact proves the plugin asked the focus query and did not drop that canned
hit. It does not prove the live index returns that fact for that query.
