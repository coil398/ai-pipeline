# ai-pipeline

A small JavaScript engine for fixed, data-defined workflows that combine language model steps, commands, and deterministic decisions. It uses Node.js built-ins and needs no build step.

## Run

```sh
node bin/aip.js run examples/review-loop/workflow.json --run-id sample --runs-dir /tmp/aip-runs --llm examples/review-loop/fixtures/loop
node bin/aip.js status --run-id sample --runs-dir /tmp/aip-runs
```

Use `continue` to resume an interrupted run, `rerun --from <step>` to reset a step and its downstream path, and `render` for a compact text view. Use `--llm run:<run-id>` to replay language model outputs from another run. See [the definition guide](docs/definition.md) and the two examples.

Run checks with `node --test` and type-check with `npx -y -p typescript@5.6.3 tsc --project .`.
