# ai-pipeline

A small JavaScript engine for data-defined workflows combining language model steps, commands, and deterministic decisions. It uses Node.js built-ins and needs no build step.

## Run

```sh
node bin/aip.js run examples/review-loop/workflow.json --run-id sample --runs-dir /tmp/aip-runs --llm examples/review-loop/fixtures/loop
node bin/aip.js status --run-id sample --runs-dir /tmp/aip-runs
node bin/aip.js continue --run-id sample --runs-dir /tmp/aip-runs
node bin/aip.js rerun --run-id sample --from critic --runs-dir /tmp/aip-runs
```

Execution starts at the first step. Each completed step activates its `next` targets; omitting `next` activates the next step in the array, and `next: []` ends that path. A `decide` activates the first matching case's `goto`, or its optional `default`. Each decision's `max` limits its total executions. `inputs` and `output` / `outputs` carry artifacts. `waitFor` joins paths by requiring fresh completions from all listed steps.

The engine saves the pending set (`frontier`), decision counts, step execution counts, and current artifacts after each step completes. `continue` resumes that frontier. `rerun --from <step>` starts with only that step pending and resets all decision counts, preserving artifacts and step versions. `render` shows a compact text view. `--parallel <n>` limits concurrent steps, together with gateway `maxParallel` limits. See [the definition guide](docs/definition.md), [review-loop](examples/review-loop/workflow.json), and [design-change](examples/design-change/workflow.json).

Use `--llm <fixture-directory>`, `--llm human`, or `--llm run:<run-id>` for fixture responses, human responses, or replay from another run. Run checks with `npm test` (`node --test`).

An `exec` step can name a local `component` instead of `argv`. Set `components` in the workflow or use `--components <dir>`; each component runs `<dir>/<name>/run.mjs` with the standard `AIP_MANIFEST` input and output paths. See [components](docs/definition.md#components).

## LLM routes

Place `routes.json` and `gateways.json` beside `workflow.json`. Routes map names to ordered `{gateway, model, effort}` entries. Gateways use the built-in `openai-chat` HTTP interface or `exec` CLI interface; credentials are read from the named environment variable. For `openai-chat`, optional `envFile` reads that key from a KEY=VALUE file when the process environment variable is empty; relative paths are resolved from `gateways.json`. Optional `headers` adds string-valued HTTP headers; `{requestId}` is replaced with a fresh UUID for each request.
Override the files with `--routes <path>` and `--gateways <path>`. Rate and usage limits cool down the gateway and advance to the next route. See [the definition guide](docs/definition.md) for configuration details.
