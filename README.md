# ai-pipeline

`ai-pipeline` is a small, data-defined workflow engine for running language-model calls, local commands, and deterministic decisions as one resumable run. A workflow declares its steps, artifact inputs and outputs, and transitions. The engine schedules active steps, records each result, and can resume or rerun a selected step.

The engine provides generic execution primitives. It does not define vocabulary, checks, hooks, roles, or policies for a particular application. Application-specific workflows, role text, routes, gateways, and components belong to the consuming project.

## Requirements and installation

Node.js 22 or later is required. The package is published from its Git repository. Consumers should pin a commit so their workflow uses a known engine revision:

```sh
npm install --save ai-pipeline@git+https://github.com/coil398/ai-pipeline.git#<commit>
```

Run the installed CLI through npm's binary lookup or by its package path:

```sh
npx aip run path/to/workflow.json --run-id example
node_modules/ai-pipeline/bin/aip.js status --run-id example
```

The source checkout can also run `node bin/aip.js <command>`. No build step is required.

## CLI

All paths are resolved from the current working directory unless the definition specifies a path relative to `workflow.json`. The default run directory is `runs`; pass the same `--runs-dir` when operating on a run stored elsewhere.

```text
aip run <workflow.json> --run-id <id> [--inputs <file.json>] [--components <dir>] [--runs-dir <dir>] [--parallel <n>] [--llm <fixture-dir>|human|run:<run-id>] [--routes <path>] [--gateways <path>] [--fallbacks <path>]
aip continue --run-id <id> [--components <dir>] [--runs-dir <dir>] [--parallel <n>] [--llm <fixture-dir>|human|run:<run-id>] [--routes <path>] [--gateways <path>] [--fallbacks <path>]
aip rerun --run-id <id> --from <step> [--components <dir>] [--runs-dir <dir>] [--parallel <n>] [--llm <fixture-dir>|human|run:<run-id>] [--routes <path>] [--gateways <path>] [--fallbacks <path>]
aip status --run-id <id> [--runs-dir <dir>]
aip render --run-id <id> [--runs-dir <dir>]
```

- `run` creates a run from a workflow. `--inputs` supplies a JSON object mapping declared input IDs to paths; paths in that JSON are relative to the JSON file. Only named inputs are replaced.
- `--components` overrides the workflow's component directory. The selected directory is saved in run state and reused when continuing or rerunning.
- `--runs-dir` selects the parent directory for run directories. `--run-id` names the run directory within it.
- `--parallel` sets the maximum number of ordinary ready steps scheduled together (default `4`); an LLM gateway's `maxParallel` can further limit requests to that gateway.
- `--llm <fixture-dir>` reads fixture responses; `--llm human` waits for a human response; `--llm run:<run-id>` replays outputs from another run. Without this option, configured routes are used.
- `--routes` and `--gateways` override the corresponding JSON files beside the workflow. They are also accepted by `continue` and `rerun`.
- A gateway may declare `peakHours` as windows like `[{"days":[1,2,3,4,5],"start":"01:00","end":"04:00"}]`. Days and times use UTC; the start is inclusive and end exclusive. If `end` is at or before `start`, the window crosses midnight and `days` refers to the starting weekday. At each routed LLM call, entries whose gateway is currently in peak hours are stably moved after entries that are off-peak or have no `peakHours`; if the first entry changes, an INFO `route_offpeak_order` log records the route and resulting gateway order. `peakHours` is validated at startup.
- `fallbacks.json` beside the workflow optionally maps each `<gateway>:<model>` to an ordered array of alternate `{gateway, model, effort?}` entries. An alternate without `effort` inherits it from the route entry. Each route entry is followed by its alternates; limit and transient communication errors advance to the next entry. `--fallbacks` overrides this file and is accepted by `run`, `continue`, and `rerun`. If the file is absent, no alternates are added.
- `exec` gateway configurations accept `timeoutMs`; timed out processes receive SIGTERM and then SIGKILL after 10 seconds. Without `timeoutMs`, they have no time limit.
- `openai-chat` gateway configurations accept `idleTimeoutMs` (default `300000` ms); it aborts a request if response headers or the next stream chunk do not arrive in time. Set it to `0` to disable the idle timeout.
- `continue` resumes the saved frontier. `rerun --from <step>` makes only the named step pending and clears decision case counts while retaining artifacts and prior step versions.
- `continue` consumes a human response from the waiting step version. Values in `exec.argv` are passed through as process arguments; only declared inputs, roles, and component entry points are checked as files.
- LLM cooldown updates merge under a `.lease` file, and gateways are checked again before a request is sent. LLM usage records include usage returned by failed calls.
- `status` prints the state JSON. `render` prints a compact status view.

The CLI reports a nonzero exit code for failed runs, a `max-rounds` stop, and a missing fixture response. A run waiting for input or a human response is represented in its saved state.

## Workflow definition

See [the workflow definition guide](docs/definition.md) for the complete schema and examples. It covers inputs, artifacts and manifests, `llm`, `exec`, `decide`, `map`, components, transitions and joins, routes and gateways, state files, leases, resume and rerun, and fixture/human/run replay. The `examples/` directory contains complete workflows with local inputs, roles, routes, gateways, scripts, and fixtures.

Documentation:

- `README.md`: purpose, installation, CLI, and test entry point.
- [`docs/definition.md`](docs/definition.md): workflow authoring and runtime behavior.

## Examples

- [review-loop](examples/review-loop/workflow.json) shows a writer/reviewer loop driven by a decision and a case limit.
- [design-change](examples/design-change/workflow.json) shows branched steps, a join, command execution, and fixture-backed model steps.

Run an example without calling an external model:

```sh
node bin/aip.js run examples/review-loop/workflow.json --run-id sample --runs-dir /tmp/aip-runs --llm examples/review-loop/fixtures/loop
node bin/aip.js status --run-id sample --runs-dir /tmp/aip-runs
node bin/aip.js render --run-id sample --runs-dir /tmp/aip-runs
```

## Tests

Run `npm test` to execute the Node.js test suite (`node --test`). The suite includes a source-vocabulary test over `src/` and `bin/`: workflow-engine code remains generic, with `verdict` permitted only in the decision step implementation. Keep application-specific vocabulary out of those engine directories.

## Changing the engine

Commit and push engine changes to this repository. In each consuming repository, update the Git dependency to the intended commit and commit that dependency change. Runs use the package installed in `node_modules/ai-pipeline`; installing a new engine revision does not rewrite an existing run's saved state. Replace the dependency only when no run is in progress or needs to be resumed with its current engine version.
