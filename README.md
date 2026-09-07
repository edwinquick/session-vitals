# session-vitals

Cognitive screening for Claude Code sessions.

Long agent sessions decline the way working memory does: the context fills, gets summarized, and the model starts forgetting constraints, retrying the same failing command, re-reading the same file, and needing the same correction twice. Everyone who has used a coding agent for a few hours has felt it. Nobody measures it.

`session-vitals` measures it, from outside the model, and tells you which of four things to do:

| Action | When |
|---|---|
| **continue** | healthy, or mild signals |
| **compact** | the window is heavy with exploration but the task is still held |
| **handoff** | understanding is slipping; write a handoff doc while the session can still be trusted to write one |
| **abandon** | the session cannot be trusted to summarize itself; restart from git and the issue |

It also fixes the one thing known to go wrong in compaction: constraints stated in user turns lose 30 to 50 points of adherence after a summary ([Governance Decay, 2026](https://arxiv.org/abs/2606.22528)). Pinned constraints are re-injected verbatim after every compaction.

## How it works

Two layers, kept deliberately separate:

**Informant layer** (hooks, zero model involvement). On every prompt and every turn end, a script parses the session transcript and computes: context fill, compaction count and thrashing, recent tool error rate and its slope, identical-retry runs, files re-read three or more times, user corrections in the last six prompts, prompts since the last edit or commit. A one-line readout appears when the tier worsens or every five prompts.

**Patient layer** (the `/vitals` skill). The model answers a retention probe from memory: what is the task, what constraints are in force, which files have you edited, what did the user last correct. A script scores the answers against the transcript and the pins. Mismatches feed back into the rubric.

The informant outranks the patient. The full decision table, thresholds, and rationale are in [docs/rubric.md](docs/rubric.md).

## Install

```bash
claude plugin marketplace add edwinquick/session-vitals
claude plugin install session-vitals@session-vitals
```

Or for local development, from a checkout:

```bash
claude --plugin-dir /path/to/session-vitals
```

Requires Node 20 or newer on `PATH`. No dependencies.

## Use

Mostly you do nothing. Warnings look like:

```
Session vitals: DEGRADED (score 6) · context 78% · context:2 corrections:1 rereads:1 → compact. /vitals for the full readout.
```

Then:

- `/vitals` runs the full screen: informant report, retention probe, recommendation, and the concrete next command.
- `/vitals pin "never push to main"` pins a standing constraint so it survives compaction. Constraint-shaped sentences in your prompts are also captured automatically.
- `/vitals pins`, `/vitals unpin 2` manage pins.

From a shell:

```bash
node scripts/vitals-cli.mjs report --transcript ~/.claude/projects/<project>/<session>.jsonl
```

## Configuration

Environment variables, read by the hooks:

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_VITALS_REPORT_EVERY` | `5` | prompts between routine readouts |
| `SESSION_VITALS_CONTEXT_WINDOW` | detected | override the window size in tokens (`[1m]` in the model id means 1,000,000, else 200,000) |
| `SESSION_VITALS_HOME` | plugin data dir, else `~/.claude/session-vitals` | where per-session state lives |

Thresholds for the recent windows live in `config.json` under that directory (`recentToolWindow`, `recentPromptWindow`, `thrashRefillFraction`, `thrashWithinPrompts`).

## Privacy

Everything runs locally. The hooks read your own transcript file and write a small state file per session (baseline task, pins, last probe, last report) next to your Claude Code data. Nothing leaves the machine.

## Status

Early. The transcript format is not a published contract and the parser is defensive rather than complete. Thresholds are first guesses from the literature and a handful of real sessions; they will move. Issues and transcripts that fooled it are welcome.

## License

MIT
