# Workflow definition

A workflow is one `workflow.json` file with `id`, `inputs`, and an ordered `steps` array. Input paths and role paths are relative to the definition. The loader checks step IDs, artifact references, transition targets, and role/command files at load time.

## Execution and transitions

A new run starts with the first step in its pending set (`frontier`). An empty steps array completes immediately. A pending step can execute when its input artifact files exist and its `waitFor` condition is satisfied. Ready steps execute concurrently up to `--parallel` and gateway `maxParallel` limits. Steps writing the same artifact execute in separate batches.

Each completed `llm` or `exec` step activates the IDs in its optional `next` array. If `next` is omitted, it activates the following step in the steps array; the last step has no implicit successor. `next: []` ends a path. Activation is a set: multiple activations of an already pending step coalesce. Only activated steps execute. Artifact references transfer data and do not activate producers or consumers.

A step may specify `waitFor: ["left", "right"]`. Every listed step must have completed after this step's previous completion. For a step that has never completed, each listed step must have completed at least once. An activated step remains pending until this condition and its artifact requirements are met. Completion sequence numbers in state record this ordering.

When the frontier is empty, the run is `completed`. If pending steps cannot execute because inputs or fresh completions are missing, it is `waiting-input`. An execution failure leaves the failed step pending and sets the run to `failed` with a reason. Other steps already executing in that batch finish and save their results.

## Step kinds

- `llm`: `role`, `route`, ordered `inputs`, and one text `output`. The engine builds a prompt from the role text, then `# Inputs` with one `## <artifact id>` section per input, then `# Output` and the output id.
- `exec`: `argv`, `inputs`, and `outputs`. The process receives `AIP_MANIFEST`, a JSON file containing run and step ids, version, input paths with previous versions, and output paths.
- `decide`: `source`, `cases` containing `when` arrays and `goto` IDs, optional `default` ID, and a positive integer `max`. Text values are read from a `## VERDICT` section or a `VERDICT:` line. An optional `field` reads a dotted JSON field instead. Cases are evaluated in order; the first matching case activates its `goto`. Without a match, `default` is activated. If neither applies, the run fails with a reason. A decide uses only `goto` / `default` for transitions; its `next` is ignored.

Every decide execution increments `rounds[<step id>]`. Before another execution would exceed `max`, the engine stops with `stopped: max-rounds`, leaving the decide pending. All transitions use the same activation rules, including transitions to a previously executed step. Repeated execution creates a new version; each artifact's current value is the most recent write.

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

A run stores `state.json`, `run.lease`, step versions under `steps/<step>/v<N>/a1/`, and current artifact files under `artifacts/<id>`. Each execution attempt gets a new version, including retries after failure or human waiting. State saves the frontier, rounds, artifacts, execution counts (`steps[id].attempts`), and completion sequence numbers after each step completes. Concurrent state writes are serialized.

`continue` resumes the saved frontier, retrying failed or interrupted work. `rerun --from <step>` replaces the frontier with that single step and resets every decision's rounds to zero. Both preserve current artifacts and past step versions. A rerun retains `waitFor` completion history and must satisfy the same fresh-completion rule.

Fixture mode reads `--llm fixtures/<set>` from `<set>/<step>/v<N>.md`, falling back to `<set>/<step>.md`. `--llm run:<run-id>` reads the corresponding step/version from another run. Human mode writes the prompt and sets `waiting-human` until `output.md` exists in the attempt directory; continue consumes that response.

## LLM routes and gateways

Each workflow directory may contain `routes.json` and `gateways.json`; `run`, `continue`, and `rerun` accept `--routes <path>` and `--gateways <path>` to override them. A route name maps to an ordered array of `{gateway, model, effort}` entries. `openai-chat` gateways use `{kind, baseUrl, apiKeyEnv, maxParallel?, cooldownMs?, timeoutMs?}`. `exec` gateways use `{kind, argv, limitPatterns?, cooldownMs?, timeoutMs?}`; `{model}` and `{effort}` are expanded in argv, and the prompt is sent on stdin. A `human` route uses the human input flow.

A 429, 402, or matching CLI limit pattern cools down that gateway and advances to the next route. Cooldowns are stored in `~/.cache/ai-pipeline/cooldown.json`, or `AIP_COOLDOWN_PATH`. `Retry-After` takes precedence over gateway `cooldownMs`, then a 60 minute default. Other errors fail the step. Each LLM attempt writes `usage.json` with token counts and route outcomes.
