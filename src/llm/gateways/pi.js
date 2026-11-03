import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { log } from "../../io/log.js";

const envFileCache = new Map();

/** @param {any} gateway @param {{model:string,effort?:string,prompt:string,attemptDir?:string,gatewaysDir?:string,runDir?:string}} request @param {{deps?:object}} options */
export async function piGateway(gateway, request, { deps = {} } = {}) {
  const started = Date.now();
  const attemptDir = path.resolve(request.attemptDir ?? process.cwd());
  const workdir = path.join(attemptDir, "work");
  const runDir = request.runDir ?? path.resolve(attemptDir, "../../../..");
  await mkdir(workdir, { recursive: true });
  const gatewayDir = request.gatewaysDir ?? process.cwd();
  const provider = gateway.provider === "codex" ? "openai-codex" : gateway.provider;
  const context = { workdir, attemptDir, runDir };
  const customTools = [];
  for (const modulePath of gateway.toolModules ?? []) {
    const absolutePath = path.resolve(gatewayDir, modulePath);
    const loaded = await import(absolutePath);
    const tools = await loaded.default(context);
    customTools.push(...tools);
  }

  const credentials = provider === "openai-codex"
    ? await codexCredentialStore(deps.InMemoryCredentialStore ?? InMemoryCredentialStore)
    : undefined;
  const runtime = await (deps.ModelRuntime ?? ModelRuntime).create({
    ...(credentials ? { credentials } : {}),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const apiKey = await configuredApiKey(gateway, gatewayDir);
  if (gateway.apiKeyEnv && !apiKey) {
    throw new Error(`missing API key environment variable: ${gateway.apiKeyEnv}`);
  }
  if (apiKey) await runtime.setRuntimeApiKey(provider, apiKey);
  let model = runtime.getModel(provider, request.model);
  if (gateway.baseUrl && model) {
    runtime.registerProvider(provider, {
      name: provider,
      baseUrl: gateway.baseUrl,
      api: model.api,
      ...(apiKey ? { apiKey: `$${gateway.apiKeyEnv}` } : {}),
      authHeader: true,
      models: [{
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: gateway.baseUrl,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        compat: model.compat,
      }],
    });
    model = runtime.getModel(provider, request.model);
  }
  if (!model) throw new Error(`Pi model not found: ${provider}/${request.model}`);

  const settingsManager = (deps.SettingsManager ?? SettingsManager).inMemory({
    retry: { enabled: false },
  });
  const sessionManager = (deps.SessionManager ?? SessionManager).inMemory(workdir);
  const resourceLoader = new (deps.DefaultResourceLoader ?? DefaultResourceLoader)({
    cwd: workdir,
    agentDir: path.join(workdir, ".pi"),
  });
  if (typeof resourceLoader.reload === "function") await resourceLoader.reload();
  const created = await (deps.createAgentSession ?? createAgentSession)({
    cwd: workdir,
    agentDir: path.join(workdir, ".pi"),
    model,
    thinkingLevel: request.effort,
    modelRuntime: runtime,
    settingsManager,
    sessionManager,
    resourceLoader,
    tools: gateway.tools ?? [],
    customTools,
  });
  const session = created.session;
  try {
    await session.prompt(request.prompt);
    if (typeof session.waitForIdle === "function") await session.waitForIdle();
    const messages = session.messages ?? [];
    const assistants = messages.filter((message) => message.role === "assistant");
    const last = assistants.at(-1);
    if (last?.stopReason === "error") {
      const error = new Error(last.errorMessage ?? "Pi agent failed");
      if (isLimit(error)) error.kind = "limit";
      throw error;
    }
    const body = textOf(last);
    let text = body;
    if (gateway.outputFile) {
      try {
        const fileText = await readFile(path.resolve(workdir, gateway.outputFile), "utf8");
        if (fileText.trim()) text = fileText;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (!text.trim()) throw new Error("empty response");
    const usage = assistants.reduce((sum, message) => ({
      inputTokens: sum.inputTokens + (message.usage?.input ?? 0),
      outputTokens: sum.outputTokens + (message.usage?.output ?? 0),
    }), { inputTokens: 0, outputTokens: 0 });
    return {
      text,
      usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens },
    };
  } catch (error) {
    if (isLimit(error)) error.kind = "limit";
    log("ERROR", "pi_gateway_failed", {
      gateway: request.gatewayId ?? "pi",
      model: request.model,
      error: error.name ?? "Error",
    });
    throw error;
  } finally {
    await session.dispose?.();
    log("INFO", "pi_gateway_done", {
      gateway: request.gatewayId ?? "pi",
      model: request.model,
      effort: request.effort ?? null,
      elapsed_ms: Date.now() - started,
    });
  }
}

async function codexCredentialStore(Store) {
  const authFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");
  let auth;
  try {
    auth = JSON.parse(await readFile(authFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Codex login not found");
    throw error;
  }
  const tokens = auth.tokens ?? {};
  const access = tokens.access_token;
  const refresh = tokens.refresh_token;
  if (!access || !refresh) throw new Error("Codex login tokens are missing");
  const claims = decodeJwt(access);
  const accountId = tokens.account_id ?? claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (!accountId) throw new Error("Codex login account is missing");
  const expires = tokens.expires_at
    ? (Number.isFinite(Number(tokens.expires_at)) ? Number(tokens.expires_at) : Date.parse(tokens.expires_at))
    : (claims?.exp ? claims.exp * 1000 : 0);
  if (!Number.isFinite(expires)) throw new Error("Codex login expiry is invalid");
  const store = new Store();
  await store.modify("openai-codex", async () => ({
    type: "oauth",
    access,
    refresh,
    expires,
    accountId,
  }));
  return store;
}

function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function textOf(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

async function configuredApiKey(gateway, gatewayDir) {
  if (!gateway.apiKeyEnv) return undefined;
  if (process.env[gateway.apiKeyEnv]) return process.env[gateway.apiKeyEnv];
  if (!gateway.envFile) return undefined;
  const file = path.resolve(gatewayDir, gateway.envFile);
  let values = envFileCache.get(file);
  if (!values) {
    values = parseEnv(await readFile(file, "utf8"));
    envFileCache.set(file, values);
  }
  return values[gateway.apiKeyEnv];
}

function parseEnv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function isLimit(error) {
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    const status = Number(current.status ?? current.statusCode ?? current.response?.status ?? current.code);
    const message = String(current.message ?? "").toLowerCase();
    if (status === 429 || status === 402 || /rate limit|too many requests|quota exceeded|go usagelimiterror/.test(message)) return true;
    if (/insufficient[_ -]?(?:quota|credits?)|monthly.{0,50}(?:usage|quota|limit)|(?:usage|quota).{0,50}monthly|(?:usage|quota).{0,50}(?:limit|exhausted|depleted|exceeded|reached)|(?:exceeded|exhausted|depleted|reached).{0,50}(?:quota|limit)|credit balance|out of credits|payment required|billing hard limit/.test(message)) return true;
  }
  return false;
}
