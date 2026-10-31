# Workflow definition

A workflow is one `workflow.json` file with `id`, `inputs`, and an ordered `steps` array. Input paths and role paths are relative to the definition. The loader checks step IDs, artifact references, decision targets, and role/command files once at load time.

## Steps

- `llm`: `role`, ordered `inputs`, and one text `output`. The engine builds a prompt from the role text, then `# Inputs` with one `## <artifact id>` section per input, then `# Output` and the output id.
- `exec`: `argv`, `inputs`, and `outputs`. The process receives `AIP_MANIFEST`, a JSON file containing run and step ids, version, input paths with previous versions, and output paths.
- `decide`: `source`, exhaustive `cases` (`when` values and `goto` step), and `max`. Text values are read from a `## VERDICT` section or a `VERDICT:` line. A selected forward target runs only after selection. A backward target resets its dependent path and the decision step; each decision counts its own backward returns for the run and stops at `max`.

## Run files

A run stores `state.json`, `run.lease`, immutable step versions under `steps/<step>/v<N>/a<K>/`, and current artifact files under `artifacts/<id>`. `continue` retries unfinished work. `rerun --from <step>` resets that step and later steps, as well as rounds associated with the reset path.

Fixture mode reads `--llm fixtures/<set>` from `<set>/<step>/v<N>.md`, falling back to `<set>/<step>.md`. Human mode writes the prompt and waits for `output.md` in the same attempt directory; continue consumes that file.

## LLM routes and gateways

Each workflow directory may contain `routes.json` and `gateways.json`; `run`, `continue`, and `rerun` accept `--routes <path>` and `--gateways <path>` to override them. A route name maps to an ordered array of `{gateway, model, effort}` entries. `openai-chat` gateways use `{kind, baseUrl, apiKeyEnv, maxParallel?, cooldownMs?, timeoutMs?}`. `exec` gateways use `{kind, argv, limitPatterns?, cooldownMs?, timeoutMs?}`; `{model}` and `{effort}` are expanded in argv, and the prompt is sent on stdin. A `human` route uses the existing human input flow.

A 429, 402, or matching CLI limit pattern cools down that gateway and advances to the next route. Cooldowns are stored in `~/.cache/ai-pipeline/cooldown.json`, or `AIP_COOLDOWN_PATH`. `Retry-After` takes precedence over gateway `cooldownMs`, then a 60 minute default. Other errors fail the step. Each LLM attempt writes `usage.json` with token counts and route outcomes.
