# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ibr6ixhim/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ibr6ixhim/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON edit lists to a tree of files, exactly as `SPEC.md` specifies. Node 22, standard library only — no dependencies. Matching is three-tier (exact, whitespace-normalized, fuzzy), and writes are all-or-nothing: if any hunk fails, no file changes.

## Files

- `main.ts` — the CLI. Run as `node main.ts [options] [PATCH]`.
- `runner.ts` — trial harness: reads checks from the environment and runs `main.ts` on each one in a fresh directory.
- `check.ts` — the practice set on your own machine: `node check.ts <practice.json>`.
- `SPEC.md` — the full specification.

## Run it

```sh
node main.ts [patch]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=8kq0s40d&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
