# Workflow definition

A workflow is one `workflow.json` file with `id`, `inputs`, and an ordered `steps` array. Input paths and role paths are relative to the definition. The loader checks step IDs, artifact references, transition targets, and role/command files at load time.

## Runtime inputs

`aip run workflow.json --run-id example --inputs inputs.json` replaces only the specified definition input IDs. The JSON file is an object mapping input IDs to path strings, for example `{"source": "./data/source.md"}`. These paths are relative to the JSON file, while unspecified inputs remain relative to the workflow definition. Unknown IDs, invalid mappings, and missing effective input files fail before the run starts. Replaced default paths need not exist.

Resolved input paths are saved in run state. `continue` and `rerun` reuse those paths without requiring the override JSON or the replaced default files.

## Execution and transitions

A new run starts with the first step in its pending set (`frontier`). An empty steps array completes immediately. A pending step can execute when its input artifact files exist and its `waitFor` condition is satisfied. Ready steps execute concurrently up to `--parallel` and gateway `maxParallel` limits. Steps writing the same artifact execute in separate batches.

Each completed `llm` or `exec` step activates the IDs in its optional `next` array. If `next` is omitted, it activates the following step in the steps array; the last step has no implicit successor. `next: []` ends a path. Activation is a set: multiple activations of an already pending step coalesce. Only activated steps execute. Artifact references transfer data and do not activate producers or consumers.

A step may specify `waitFor: ["left", "right"]`. Every listed step must have completed after this step's previous completion. For a step that has never completed, each listed step must have completed at least once. An activated step remains pending until this condition and its artifact requirements are met. Completion sequence numbers in state record this ordering.

When the frontier is empty, the run is `completed`. If pending steps cannot execute because inputs or fresh completions are missing, it is `waiting-input`. An execution failure leaves the failed step pending and sets the run to `failed` with a reason. Other steps already executing in that batch finish and save their results.

## Step kinds

- `llm`: `role`, `route`, ordered `inputs`, and one text `output`. The engine builds a prompt from the role text, then `# Inputs` with one `## <artifact id>` section per input, then `# Output` and the output id.
- `exec`: exactly one of `argv` or `component`, plus `inputs` and `outputs`. The process receives `AIP_MANIFEST`, a JSON file containing run and step ids, version, input paths with previous versions, and output paths.
- `decide`: `source`, `cases` containing `when` arrays, `goto` IDs, and an optional positive integer `max`, plus an optional `default` ID. A decide-level `max` is rejected. Text values are read from a `## VERDICT` section or a `VERDICT:` line. An optional `field` reads a dotted JSON field instead. Cases are evaluated in order; the first matching case activates its `goto`. Without a match, `default` is activated. If neither applies, the run fails with a reason. A decide uses only `goto` / `default` for transitions; its `next` is ignored.

### Map steps

A `map` step reads JSON from its `items` artifact, which must contain an array. For each element it runs the ordered inner `steps` with that element available under `itemArtifact`, then writes the last inner step's text output as the corresponding element of a JSON array at `output`. Inner steps may be `llm` or `exec`; they cannot define workflow transitions or joins. Outer workflow inputs are visible to inner steps, and inner outputs can be passed to later inner steps. `maxConcurrency` optionally limits item concurrency; otherwise `--parallel` is used. A failed map item fails the map step. On retry, completed item outputs already present in the map version are reused.

```json
{
  "id": "summarize-items",
  "inputs": { "items": "items.json" },
  "steps": [{
    "id": "summarize",
    "kind": "map",
    "items": "items",
    "itemArtifact": "item",
    "output": "summaries",
    "steps": [{
      "id": "one-summary",
      "kind": "llm",
      "role": "roles/summarizer.md",
      "route": "default",
      "inputs": ["item"],
      "output": "summary"
    }]
  }]
}
```

Selecting a case with `max` increments `rounds[<step id>][<zero-based case index>]`. Before a selection would exceed that case's `max`, the engine stops with `stopped: max-rounds`, leaving the decide pending and its count unchanged. Cases without `max` and the default transition are not counted. Saved numeric decision counts from older states are discarded on load; case counts start at zero. All transitions use the same activation rules, including transitions to a previously executed step. Repeated execution creates a new version; each artifact's current value is the most recent write.

```json
{
  "id": "commands",
  "inputs": {},
  "steps": [
    { "id": "start", "kind": "exec", "argv": ["node", "-e", ""], "outputs": [], "next": ["left", "right"] },
    { "id": "left", "kind": "exec", "argv": ["node", "-e", ""], "outputs": [], "next": ["join"] },
    { "id": "right", "kind": "exec", "argv": ["node", "-e", ""], "outputs": [], "next": ["join"] },
    { "id": "join", "kind": "exec", "argv": ["node", "-e", ""], "outputs": [], "waitFor": ["left", "right"], "next": [] }
  ]
}
```

## Run files and resumption

A run directory is `<runs-dir>/<run-id>`. It stores `state.json`, a `run.lease` file while a CLI operation owns the run, step versions under `steps/<step>/v<N>/a1/`, and current artifact files under `artifacts/<id>`. Step attempt directories contain prompt/output files for LLM steps, `usage.json` for LLM attempts, and a `manifest.json` plus `stderr.log` for exec steps. A map stores per-item work under its step version. Each non-map step execution attempt gets a new version, including retries after failure or human waiting. A failed or interrupted map reuses its current version when retried. State saves the workflow path, resolved input paths, frontier, rounds, artifacts, execution counts (`steps[id].attempts`), and completion sequence numbers as steps finish. Concurrent state writes are serialized.

`continue` resumes the saved frontier, retrying failed or interrupted work. `rerun --from <step>` replaces the frontier with that single step and resets every case's count to zero. Both preserve current artifacts and past step versions. A rerun retains `waitFor` completion history and must satisfy the same fresh-completion rule.

Fixture mode reads `--llm fixtures/<set>` from `<set>/<step>/v<N>.md`, falling back to `<set>/<step>.md`. `--llm run:<run-id>` reads the corresponding step/version from another run. Human mode writes the prompt and sets `waiting-human` until `output.md` exists in the attempt directory; continue consumes that response.

## LLM routes and gateways

Each workflow directory may contain `routes.json`, `gateways.json`, and optionally `fallbacks.json`; `run`, `continue`, and `rerun` accept `--routes <path>`, `--gateways <path>`, and `--fallbacks <path>` to override them. If `fallbacks.json` is absent, no alternates are added. A route name maps to an ordered array of `{gateway, model, effort}` entries. `fallbacks.json` maps `<gateway>:<model>` keys to ordered arrays of `{gateway, model, effort?}` entries, for example:

```json
{
  "opencode-go:deepseek-v4.1-flash": [
    { "gateway": "commandcode", "model": "deepseek/deepseek-v4.1-flash" },
    { "gateway": "ollama", "model": "deepseek-v4.1-flash" }
  ]
}
```

For every route entry, its configured alternates are inserted immediately after it. Expansion is one level deep, duplicate gateway/model/effort entries keep their first position, and an alternate without `effort` inherits the originating route entry's effort. Only limit errors advance to the next entry. Fallback entries must reference configured gateways. `openai-chat` gateways use `{kind, baseUrl, apiKeyEnv, envFile?, headers?, maxParallel?, cooldownMs?, timeoutMs?, idleTimeoutMs?}`. `idleTimeoutMs` defaults to `300000` ms and aborts the request if response headers or the next stream chunk do not arrive in time; `0` disables this timeout. `exec` gateways use `{kind, argv, outputFile?, limitPatterns?, maxParallel?, cooldownMs?, timeoutMs?}`; `{model}`, `{effort}`, and `{workdir}` are expanded in argv, and the prompt is sent on stdin. Each exec process runs in a `work/` directory under its LLM step attempt directory (`steps/<step>/v<N>/a<M>/work/`). If `timeoutMs` is set and expires, the process receives SIGTERM followed by SIGKILL after 10 seconds; without it, the process has no time limit. If `outputFile` names a non-empty file in that directory, its contents become the LLM output; otherwise stdout is used. A route named `human` uses the human input flow. `envFile` is used only when the named process environment variable is empty; relative paths are resolved from `gateways.json`. Headers are string values and `{requestId}` is replaced for each request.

A 429, 402, or matching CLI limit pattern cools down that gateway and tries the next currently available entry in route order. If all entries are cooling down, the router waits until the earliest cooldown expires and writes a WARN `route_wait` log with the route, each gateway's cooldown expiry, and the wait duration in milliseconds. A limit response writes a WARN `gateway_limited` log with the gateway, model, and cooldown expiry. Cooldowns are stored in `~/.cache/ai-pipeline/cooldown.json`, or `AIP_COOLDOWN_PATH`. `Retry-After` takes precedence over gateway `cooldownMs`, then a 60 minute default. Other errors fail the step. Each LLM attempt writes `usage.json` with token counts and route outcomes; gateways without token accounting record zero counts.

## Components

An `exec` step specifies exactly one of `argv` or `component`, with the same `inputs` and `outputs` in either form. A component is a directory named by the step's `component` (letters, digits, underscores, and hyphens), containing a `run.mjs` entry. The engine starts that entry with its Node.js executable in the workflow directory and passes the regular `AIP_MANIFEST`. The component reads the manifest's input paths and writes its output paths. It has no engine hooks or validation interface.

Set the workflow's `components` directory relative to `workflow.json`, or pass `--components <dir>` relative to the CLI working directory to override it. The CLI override is saved with the run and reused by `continue` and `rerun`; either command can override it again.

```json
{
  "id": "transform",
  "components": "../../components",
  "inputs": { "source": "source.md" },
  "steps": [
    { "id": "convert", "kind": "exec", "component": "convert-table", "inputs": ["source"], "outputs": ["table"] }
  ]
}
```
