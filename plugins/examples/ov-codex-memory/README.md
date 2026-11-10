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
the device label, `session_id`, and `turn_id`, searches OpenViking with
`POST /api/v1/search/find`, and returns only JSON Codex accepts for that event:

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<ov-codex-context>\n...\n</ov-codex-context>"}}
```

Recalled text is untrusted data inside that delimiter, cut to 2000 characters.
Tags that would close the delimiter are neutralized. The search body is not
returned raw: Codex rejects unexpected fields (`deny_unknown_fields` on
`UserPromptSubmitCommandOutputWire`).

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

OpenViking's URL and API key stay in `~/.openviking/ovcli.conf` (or
`OPENVIKING_CLI_CONFIG_FILE`) on that computer. The URL must be loopback:
`127.0.0.1`, `localhost`, or `::1`. A LAN or public URL is refused. Redirects
are refused. Do not put a Magpie gateway key in the plugin options.

Optional plugin options:

```json
{ "timeoutMs": 8000 }
```

`timeoutMs` is an integer from 100 to 15000. The default is 8000. State is
under `dataDir` or `~/.openviking/ov-codex-memory/`, mode 0600 files, at most
200 stored prompts and 500 turn records.

## Codex hooks

Use a Codex build that executes `mcp_tool` hooks. The handler shipped in
openai/codex PR 38705 (merged 2026-08-15). Older builds that only parse the
handler and skip it (PR 37363) will not recall or capture. This repo was
checked against `codex-rs/hooks/src/schema.rs` on Codex `main`: `mcp_tool`
calls an already-connected server, and the tool text is parsed as hook stdout.
No Codex binary was run here.

`UserPromptSubmit` input used here is `prompt`, `session_id`, and `turn_id`.
`Stop` input used here is `session_id`, `turn_id`, and `last_assistant_message`.
Those names are the fields on `UserPromptSubmitCommandInput` and
`StopCommandInput`. `Stop` has no prompt field. Pairing works only when both
hooks see the same `session_id` and `turn_id`. If they differ, capture fails
closed and does not store the assistant text.

Copy `hooks/codex.hooks.json` into Codex's user hooks. Replace the server name
with the hub entry already in Codex's config (the one whose URL is the
remote Magpie hub). Set `device` to a stable label for this machine. Do not
add an `Authorization` header, a bearer token, or a copied key. The hook uses
the connection Codex already has.

`features.hooks` must not be false. `SessionEnd` cannot run `mcp_tool`. Do not
point `hook_task` at a hook: its JSON is not Stop output.

A missing `${last_assistant_message}` fails in Codex before this plugin is
called, because a missing placeholder is an error. Null assistant text is
rejected here and is not captured.

## DSH

Not implemented. The DSH OpenViking plugin calls OpenViking HTTP directly and
starts its own stdio proxy. It has no sanctioned call into an MCP server DSH
is already connected to. This package does not read DSH's config and does not
copy a gateway key into an environment variable. A DSH adapter would need that
host API, or a separate credential the user configures on purpose. Neither is
this plugin.

## Limits

- Search is `find` with limit 5, not the gateway hook's context-mode recall.
- One archive per device, session id, and turn id. A later Stop for that same
  triple does not commit again, including after a process restart.
- A continued turn that reuses the same turn id is not a second capture.
- Prompt and assistant text are stored up to 16000 characters each.
- `archived: true` does not mean memories are searchable yet.
- A crash after OpenViking accepts the append and before the local
  `appended` flag is written can append the pair again on retry. Retries
  after that flag, and after `accepted` or `settled`, do not.
- The plugin does not route models and does not change Cheap First or local
  embeddings. Extraction, if OpenViking schedules it, uses whatever model
  OpenViking is already configured to call on this computer.

## Tests

```sh
node --test plugins/examples/ov-codex-memory/test/plugin.test.mjs
```

The tests use a fake OpenViking client and one local hung HTTP server. They
do not call a real OpenViking, a real Codex, or a live Magpie.
