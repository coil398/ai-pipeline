import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** @param {{baseUrl:string, apiKeyEnv:string, envFile?:string, timeoutMs?:number, headers?:Record<string,string>}} gateway @param {{model:string, effort?:string, prompt:string}} request @returns {Promise<{text:string, usage:{inputTokens:number,outputTokens:number,totalTokens:number}}>} */
export async function openaiChat(gateway, request) {
  const apiKey = gateway.apiKeyEnv
    ? process.env[gateway.apiKeyEnv] ||
      (gateway.envFile ? await readEnvValue(gateway.envFile, gateway.apiKeyEnv) : undefined)
    : undefined;
  if (gateway.apiKeyEnv && !apiKey) {
    throw new Error(`missing API key environment variable: ${gateway.apiKeyEnv}`);
  }
  const controller = new AbortController();
  const timer = gateway.timeoutMs
    ? setTimeout(() => controller.abort(), gateway.timeoutMs)
    : undefined;
  const requestId = randomUUID();
  try {
    const response = await fetch(
      `${gateway.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey
            ? { authorization: `Bearer ${apiKey}` }
            : {}),
          ...Object.fromEntries(
            Object.entries(gateway.headers ?? {}).map(([name, value]) => [
              name,
              value.replaceAll("{requestId}", requestId),
            ]),
          ),
        },
        body: JSON.stringify({
          model: request.model,
          messages: [{ role: "user", content: request.prompt }],
          ...(request.effort ? { reasoning_effort: request.effort } : {}),
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      },
    );
    if (response.status === 429 || response.status === 402) {
      const error =
        /** @type {any} */ (new Error(`limit: HTTP ${response.status}`));
      error.kind = "limit";
      error.retryAfterMs = retryAfter(response.headers.get("retry-after"));
      throw error;
    }
    if (!response.ok) {
      const responseText = (await response.text()).slice(0, 500);
      const safeResponseText = apiKey
        ? responseText.replaceAll(apiKey, "[REDACTED]")
        : responseText;
      throw new Error(
        `HTTP ${response.status}${safeResponseText ? `: ${safeResponseText}` : ""}`,
      );
    }
    const contentType = response.headers?.get("content-type") ?? "";
    const body = contentType.includes("text/event-stream")
      ? await readEventStream(response.body)
      : await response.json();
    const text = body.text ?? body.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new Error("empty response");
    const usage = body.usage ?? {};
    return {
      text,
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function readEventStream(stream) {
  let text = "";
  let usage = {};
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return { text, usage };
      if (!data) continue;
      const event = JSON.parse(data);
      const content = event.choices?.[0]?.delta?.content;
      if (typeof content === "string") text += content;
      if (event.usage) usage = event.usage;
    }
  }
  buffer += decoder.decode();
  const line = buffer.replace(/\r$/, "");
  if (line.startsWith("data:")) {
    const data = line.slice(5).trim();
    if (data && data !== "[DONE]") {
      const event = JSON.parse(data);
      const content = event.choices?.[0]?.delta?.content;
      if (typeof content === "string") text += content;
      if (event.usage) usage = event.usage;
    }
  }
  return { text, usage };
}
async function readEnvValue(file, name) {
  const contents = await readFile(file, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0 || trimmed.slice(0, separator).trim() !== name) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}
function retryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds)
    ? seconds * 1000
    : Math.max(0, Date.parse(value) - Date.now());
}
