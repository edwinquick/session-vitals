# The rubric

Cognitive screening for agent sessions. A session is a patient whose working memory (the context window) fills, gets summarized, and drifts. The clinic has two sources of evidence, and this rubric keeps them separate on purpose:

- **Informant report.** Measured from the transcript by a script. The model cannot influence it. Analogous to the AD8, where a family member answers about the patient.
- **Patient interview.** The model answers a retention probe from memory and a script scores it against the record. Analogous to the MMSE or MoCA.

The informant outranks the patient. A model inside a degraded context will report feeling fine.

`scripts/lib/rubric.mjs` implements this table and must stay in step with it.

## Signals and severities

| Signal | 1 | 2 | 3 | Notes |
|---|---|---|---|---|
| `context` (fill of the window) | > 55% | > 75% | > 90% | Rot begins well before the window is full (Chroma, 2025). Percent of the model's window, detected from the model id (`[1m]` means 1M). |
| `compaction` (count in the last 40 prompts) | 1 | 2 | 3+ | Three or more lifetime compactions score at least 1. +1 for **fast refill**: context back to 50% of the window within 10 prompts of the last compaction (measured from the compaction event itself, so the peak-fill turn that triggered it does not count). +1 and hard critical for **thrashing**: two compactions within 10 prompts of each other, the second in the last 40. Either means the working pattern must change, not that another compaction is due. Recency matters because six compactions across a week-long session is a heavy session, not a declining one. |
| `tool_errors` (recent 30 calls) | > 25% | > 40% | > 60% | +1 if the recent rate exceeds the session rate by more than 20 points (a rising slope). Ignored under 5 recent calls. |
| `retry_loops` | 1 run | 2 runs | 3+ runs | A run is two or more consecutive tool calls with identical name and input. |
| `rereads` | 1 file | 3 files | | Files read three or more times within the last 40 tool calls. |
| `corrections` (last 6 prompts) | 1 | 2 | 3+ | User prompts opening with a correction phrase ("no", "I meant", "you already", "again", "as I said", ...). |
| `stalled` | 6+ prompts | 12+ prompts | | Prompts since the last Edit/Write or `git commit`. Only scored once the session has edited something, so research sessions are not penalized. |
| `api_errors` | 2+ | | | |
| `probe` | | 1 mismatch | 2+ mismatches | From the patient layer. Ignored if older than 10 prompts or if a compaction or resume happened since. |

## Tier

- **critical**: any of `corrections`=3, `retry_loops`=3, `probe`=3, or thrashing; or total severity >= 9.
- **degraded**: any signal at 2, or total >= 5.
- **watch**: total >= 2.
- **healthy**: otherwise.

## Actions

Exactly four. Each has a different cost and a different failure mode.

| Tier | Condition | Action | Why |
|---|---|---|---|
| healthy | | **continue** | |
| watch | | **continue**, pin constraints now | Cheap insurance. Pinned constraints survive compaction; constraints left as user turns lose 30 to 50 points of adherence after it (Governance Decay, 2026). |
| degraded | no memory signal at 2+ (`corrections`, `probe`, `retry_loops`), no fast refill, and a volume signal present (`context` 2+, a recent compaction, or rereads) | **compact** with a focus instruction | The window is heavy with exploration but the task is still held. Summarize the noise, keep the task and the pins. |
| degraded | no memory signal, but fast refill after the last compaction | **handoff**, and change the working pattern | Another compaction buys a few prompts. A fresh session that delegates bulk reads to subagents does not refill this way. |
| degraded | otherwise | **handoff** | The signals are about lost understanding, not volume. A fresh session reading a handoff doc is cheaper than re-correcting this one, and the doc is written while the session can still be trusted to write it. |
| critical | `corrections`=3 or `probe`=3 | **abandon** | The session cannot be trusted to summarize itself. Restart from durable artifacts only: `git diff`, commits, the issue or plan, the pins. |
| critical | thrashing | **handoff**, and change the working pattern | Volume, not memory, is the problem. A fresh session that delegates bulk reads to subagents will not refill the way this one does. Abandon is not warranted while the task is still held. |
| critical | otherwise | **handoff** | Hand off before the next compaction erases what is still correct. |

Abandon is reserved for evidence of lost understanding (repeated corrections, a failed probe). Volume signals alone, however severe, never trigger it: a multi-day session with six compactions and zero corrections is heavy, not confused.

## Compaction hygiene (applies to every action)

After every compaction the `SessionStart(compact)` hook re-injects all pinned constraints verbatim, plus the original task statement, into the fresh context. Constraints are captured two ways:

- **manual**: `vitals pin "<text>"` or the `/vitals pin` skill argument. These count in the probe.
- **auto**: user prompts containing constraint-shaped sentences (never, always, do not, must, only, without) are captured automatically, capped at the twelve most recent. These are re-injected but do not count against the probe, since the heuristic is noisy.

## Practice effects

The probe is answered before the model sees its previous answers or the baseline, and the skill instructs paraphrase rather than quotation. The score compares content-word overlap, not exact text, so a correct paraphrase passes and a parroted earlier answer gains nothing over it.

## What this is not

- Not a measure of model quality. It measures one session's trajectory against its own baseline.
- Not a diagnosis. A `critical` tier is a recommendation to the human, who may know the session is fine (a long but successful debugging run will trip `tool_errors`).
- Not a substitute for subagents. Delegating high-volume reads to a subagent keeps the parent healthy far more cheaply than any of the four actions here.

## Sources

- Chroma, *Context Rot: How Increasing Input Tokens Impacts LLM Performance*, 2025.
- *Governance Decay: How Context Compaction Silently Erases Safety Constraints in Long-Horizon LLM Agents*, arXiv 2606.22528, 2026. Constraint pinning is taken from here.
- *Nautilus Compass: Black-box Persona Drift Detection for Production LLM Agents*, arXiv 2605.09863, 2026.
- Anthropic, *Using Claude Code: session management and 1M context*, 2026.
- Clinical analogues: MMSE (Folstein 1975), MoCA (Nasreddine 2005), AD8 (Galvin 2005).
