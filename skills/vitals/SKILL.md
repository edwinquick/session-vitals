---
name: vitals
description: Screen the current session for context decline and decide whether to continue, compact, hand off, or abandon. Use when the user asks for a session check, when a session-vitals warning appears, after a compaction, or when a long session starts to feel confused, repetitive, or forgetful.
argument-hint: "[report | probe | pin <constraint> | pins | unpin <n>]"
---

# Session vitals

You are running a cognitive screen on this session. Two layers, in this order:

1. **Informant** (the transcript, which you cannot bias): tool error rates, identical retries, repeated file reads, user corrections, prompts since the last edit, context fill, compaction count and thrashing.
2. **Patient** (you): a retention probe answered from memory, scored against the record.

Then apply the rubric in one of four actions. The full decision table with thresholds and rationale is in `${CLAUDE_PLUGIN_ROOT}/docs/rubric.md`.

## Arguments

- no argument or `report`: full screen (steps 1 to 4).
- `probe`: run only the retention probe (steps 2 to 3).
- `pin <constraint>`: pin a standing constraint so it is re-injected verbatim after every compaction. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/vitals-cli.mjs" pin "<text>"` and confirm to the user.
- `pins` / `unpin <n>`: list or remove pins with the same CLI.

## Step 1: informant report

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/vitals-cli.mjs" report
```

Read the signals and the recommended action. Do not adjust them from your own impression of how the session is going; that impression is exactly what is being tested.

## Step 2: retention probe (answer BEFORE looking anything up)

Print the questions with `node "${CLAUDE_PLUGIN_ROOT}/scripts/vitals-cli.mjs" probe`, then answer them from memory. Do not scroll the conversation, grep the transcript, or re-read files first. Paraphrase; do not quote earlier text. Write the answers as JSON (`task`, `constraints`, `files`, `lastCorrection`, `nextStep`) to a file in the scratch directory, then score them:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/vitals-cli.mjs" probe --answers <scratch-file>
```

The scorer compares your answers against the first user prompt, the manual pins, the files the transcript shows you edited, and recent corrections. Mismatches feed back into the report.

## Step 3: re-run the report

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/vitals-cli.mjs" report
```

The probe result is now included. This is the recommendation to act on.

## Step 4: act

Tell the user the tier, the two or three strongest signals, and the action in a few sentences. Then:

- **continue**: carry on. If the tier is `watch` and there are no manual pins, ask the user for the standing constraints for this work and pin them.
- **compact**: propose the exact `/compact` instruction, naming the task to focus on and listing the pins to keep, for example `/compact focus on <task>; keep verbatim: <pins>`. The user runs it. After compaction the SessionStart hook re-injects the pins automatically.
- **handoff**: write a handoff document for a fresh session. If a `handoff` skill is installed, invoke it; otherwise write the document yourself: goal, current state, decisions made and why, pinned constraints verbatim, files touched, open questions, next step. Save it outside the repo (scratch or temp directory), redact secrets, and tell the user to `/clear` and paste it.
- **abandon**: do not summarize from memory. The session's own account of itself is the thing in doubt. Instead list only durable artifacts the next session can read directly: `git status` and `git diff --stat`, recent commits, the issue or plan URL, and the pinned constraints. Tell the user to `/clear`, restate the task themselves, and point the new session at those artifacts.

Never claim the session is healthy because it feels healthy. The informant outranks the patient.
