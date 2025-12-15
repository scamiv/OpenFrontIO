# Replay Analyzer (performance)

Generates an offline HTML report with per-tick performance graphs by replaying a `GameRecord` / `PartialGameRecord` JSON through the same tick engine used in the worker (`GameRunner`).

## Usage

```sh
npm run replay:analyze -- path/to/replay.json
```

Options:

- `--out path/to/report.html`
- `--maxTurns 5000`
- `--economySampleEvery 10` (sample economy series every N turns; set to `1` for per-tick fidelity)
- `--verbose` (prints worker `console.*` noise instead of summarizing it)

Output defaults to `tools/replay-analyzer/out/*.report.html` (this folder is gitignored via `out/`).
