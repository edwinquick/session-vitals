# Contributing

Thanks for looking. This project lives or dies on whether its thresholds match sessions other than the author's, so the most valuable thing you can bring is a transcript that fooled it.

## Reporting a misjudged session

Open an issue with:

1. The one-line readout you saw (`Session vitals: ... → action`).
2. The output of `node scripts/vitals-cli.mjs report --json --transcript <path>`, with file paths and prompt text redacted as you see fit. The `vitals` block is what matters.
3. What you think the right call was, and why. "It said handoff but I compacted and the session was fine for another two hours" is exactly the evidence needed.

Do not attach a raw transcript. They contain your prompts, your file contents, and your tool output.

## Changing a threshold

Thresholds live in `scripts/lib/rubric.mjs` and `scripts/lib/vitals.mjs`, and every one of them is described in `docs/rubric.md`. A pull request that changes one should:

- update `docs/rubric.md` in the same commit, so the table and the code never disagree;
- say which sessions moved tier as a result, even informally;
- add or adjust a case in `test/fixtures/make-transcript.mjs` that exercises the new boundary.

## Adding a signal

A signal is worth adding if a script can compute it from the transcript alone and it separates sessions that felt fine from sessions that did not. Persona drift, contradiction density, and semantic distance from the first prompt are the obvious candidates from the literature that are not here yet, mostly because they need embeddings and this project has no dependencies. A proposal that keeps it dependency-free is welcome; one that adds a dependency should make the case for it in the issue first.

## Running tests

```bash
node --test
```

Tests use synthetic transcripts built by `test/fixtures/make-transcript.mjs`, which mirrors the Claude Code JSONL shape. If the real format changes, fix the parser in `scripts/lib/transcript.mjs` and the builder together.

## Style

Plain Node, ES modules, no build step, no dependencies. Prose in comments and docs uses ordinary sentences. Keep the four actions at four.
