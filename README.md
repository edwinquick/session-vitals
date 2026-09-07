# session-vitals

**Cognitive screening for Claude Code sessions.** Measures context decline from outside the model and tells you whether to continue, compact, hand off, or start over.

[![test](https://github.com/edwinquick/session-vitals/actions/workflows/test.yml/badge.svg)](https://github.com/edwinquick/session-vitals/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-lightgrey)

```
Session vitals: DEGRADED (score 8) · context 83% · context:2 retry_loops:2 corrections:2 → handoff. /vitals for the full readout.
```

## The problem

A long agent session declines the way working memory does. The context fills with exploration, gets summarized, and the model starts forgetting constraints, retrying the same failing command, re-reading the same file, and needing the same correction twice. Anyone who has run a coding agent for a few hours has felt it.

Two things make it hard to act on:

1. **The model is the last to know.** Asked how the session is going, a model inside a degraded context says fine. That is the same reason dementia screening does not rely on the patient's self-report.
2. **The fix is not always the same.** Sometimes `/compact` is right. Sometimes a handoff document and a fresh session is cheaper. Sometimes the session is confused enough that its own summary cannot be trusted, and the only safe move is to restart from git and the issue tracker. Picking wrong costs an hour either way.

The research is ahead of the tooling here. Context rot is measured ([Chroma, 2025](https://research.trychroma.com/context-rot)). Compaction is known to erase constraints stated in user turns, losing 30 to 50 points of adherence after a summary ([Governance Decay, 2026](https://arxiv.org/abs/2606.22528)). Drift detectors exist for production chatbots. Nothing puts those together into a decision for the person sitting at a coding agent. This does.

## What it does

**Watches from outside.** Four lightweight hooks parse the session transcript on every prompt and every turn end. No model call, no network, about 300 ms on a 70 MB transcript. They compute:

| Signal | What it catches |
|---|---|
| context fill | how full the window is, against the model's real window size |
| compaction recency, fast refill, thrashing | compactions that buy only a few prompts before the next one |
| tool error rate and its slope | a debugging loop that is getting worse, not better |
| identical retry runs | the same command with the same input, again |
| re-read files | the same file read three or more times in the recent window |
| user corrections | prompts opening with "no", "I meant", "you already", "again", "your context is stale" |
| prompts since progress | a session that has stopped editing or committing |

**Probes the model.** The `/vitals` skill asks the model to state, from memory and before looking anything up: the task, the constraints in force, the files it has edited, and the last correction it received. A script scores the answers against the record. The informant outranks the patient.

**Decides.** A rubric maps the signals to exactly four actions:

| Action | When | What you do |
|---|---|---|
| **continue** | healthy, or mild signals | nothing; pin your constraints if you have not |
| **compact** | the window is heavy with exploration but the task is still held | `/compact` with the focus instruction it gives you |
| **handoff** | understanding is slipping, or compaction is refilling too fast | write a handoff doc while the session can still be trusted to write one, then `/clear` |
| **abandon** | three corrections in six prompts, or a failed retention probe | restart from durable artifacts only: `git diff`, commits, the issue. The session's own summary is the thing in doubt |

**Pins constraints across compaction.** Sentences like "never push to main" or "do not touch the schema" are captured from your prompts (or pinned explicitly) and re-injected verbatim into the fresh context after every compaction. This is the one mitigation shown to bring post-compaction constraint violations back to zero.

The full decision table, thresholds, and the reasoning behind each are in [docs/rubric.md](docs/rubric.md).

## Install

```bash
claude plugin marketplace add edwinquick/session-vitals
claude plugin install session-vitals@session-vitals
```

To try it from a checkout without installing:

```bash
git clone https://github.com/edwinquick/session-vitals
claude --plugin-dir ./session-vitals
```

Needs Node 20 or newer on `PATH`. No dependencies.

## Use

Mostly you do nothing. A one-line readout appears when the tier worsens, and every five prompts as a routine check. When it says something other than `continue`, run `/vitals` for the full screen:

```
SESSION VITALS  tier=degraded  score=8  action=handoff

Context     167k / 200k (83%), peak 167k
Session     3 prompts, 12 tool calls, 9 min, 0 compaction(s)
Errors      recent 33% vs session 33%, 2 retry run(s), 0 API error(s)
Corrections 2 in last 6 prompts, 2 total
Progress    2 prompt(s) since last edit/commit, 1 file(s) edited
Re-reads    src/auth.test.ts×6

Signals
  [2] context: context 83% of 200k (167k)
  [2] retry_loops: 2 identical-retry runs in recent tool calls
  [2] corrections: 2 corrections from the user in the last 6 prompts (2 total)
  [1] tool_errors: 33% of last 12 tool calls failed (session 33%)
  [1] rereads: re-read 3+ times: src/auth.test.ts

Recommendation: HANDOFF
  Signals point at lost understanding rather than a full window. A fresh session with a handoff doc is cheaper than re-correcting this one.
  How: Write a handoff doc, then /clear and paste it

Pinned constraints (1)
  - Do not touch the database schema.
```

The skill then runs the retention probe, re-scores, and carries out the action: it drafts the `/compact` instruction, writes the handoff document, or lists the durable artifacts for a restart.

Other commands:

| Command | Effect |
|---|---|
| `/vitals` | full screen: report, probe, recommendation, action |
| `/vitals probe` | retention probe only |
| `/vitals pin "never push to main"` | pin a constraint for re-injection after compaction |
| `/vitals pins`, `/vitals unpin 2` | list or remove pins |

From a shell, against any transcript:

```bash
node scripts/vitals-cli.mjs report --transcript ~/.claude/projects/<project>/<session>.jsonl
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_VITALS_REPORT_EVERY` | `5` | prompts between routine readouts |
| `SESSION_VITALS_CONTEXT_WINDOW` | detected | window size in tokens. Detected as 1,000,000 when the model id or the `model` in a Claude settings file carries `[1m]`, or once the session has held more than 200k tokens; otherwise 200,000 |
| `SESSION_VITALS_HOME` | plugin data dir, else `~/.claude/session-vitals` | where per-session state lives. The CLI also searches `~/.claude/plugins/data/session-vitals*`, so it finds hook state without this being set |

Window thresholds (`recentToolWindow`, `recentPromptWindow`, `thrashRefillFraction`, `thrashWithinPrompts`, `recentCompactionPrompts`) can be overridden in `config.json` under that directory.

## Design notes

- **Two layers, never merged.** Transcript-derived metrics are computed by a script the model cannot influence. The model's self-assessment is scored against them, not averaged with them. When they disagree, the transcript wins.
- **Practice effects.** The probe is answered before the model sees its earlier answers or the baseline, and the skill asks for paraphrase. Scoring uses content-word overlap, so a correct paraphrase passes and a parroted answer gains nothing.
- **Recency over lifetime.** Six compactions across a week-long session is a heavy session, not a declining one. Compactions are scored within the last forty prompts, error rate within the last thirty tool calls, corrections within the last six prompts.
- **Volume never triggers abandon.** However full the window, however many compactions, the session is only abandoned on evidence of lost understanding: repeated corrections or a failed probe. Everything else gets a handoff at worst.
- **Subagents are the real cure.** The cheapest way to keep a parent session healthy is to delegate bulk reads to a subagent with its own window. The rubric says so whenever it detects fast refill.

## Privacy

Everything runs locally. The hooks read your own transcript and write one small state file per session (baseline task, pins, last probe, last report) under your Claude Code data directory. Nothing leaves the machine. Never commit a real transcript as a test fixture; the synthetic builder in `test/fixtures/` exists so you do not have to.

## Status and contributing

Early. Thresholds are first guesses from the literature, calibrated against a handful of real sessions, and they will move. The transcript format is not a published contract and the parser is defensive rather than complete.

The most useful contribution is a session that fooled it: a false alarm on a healthy session, or a silence on one that had clearly lost the thread. Open an issue with the one-line readout, the `report --json` output with paths redacted, and what you think it should have said. Pull requests that change a threshold should say which transcripts moved and how.

```bash
node --test
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Sources

- Chroma, *Context Rot: How Increasing Input Tokens Impacts LLM Performance*, 2025.
- *Governance Decay: How Context Compaction Silently Erases Safety Constraints in Long-Horizon LLM Agents*, arXiv 2606.22528, 2026.
- *Nautilus Compass: Black-box Persona Drift Detection for Production LLM Agents*, arXiv 2605.09863, 2026.
- Anthropic, *Using Claude Code: session management and 1M context*, 2026.
- Clinical analogues: MMSE (Folstein, 1975), MoCA (Nasreddine, 2005), AD8 (Galvin, 2005).

## License

[MIT](LICENSE)
