/** @param {{baseUrl:string, apiKeyEnv:string, timeoutMs?:number}} gateway @param {{model:string, effort?:string, prompt:string}} request @returns {Promise<{text:string, usage:{inputTokens:number,outputTokens:number,totalTokens:number}}>} */
export async function openaiChat(gateway, request) {
  const apiKey = gateway.apiKeyEnv ? process.env[gateway.apiKeyEnv] : undefined;
  if (gateway.apiKeyEnv && !apiKey) {
    throw new Error(`missing API key environment variable: ${gateway.apiKeyEnv}`);
  }
  const controller = new AbortController();
  const timer = gateway.timeoutMs
    ? setTimeout(() => controller.abort(), gateway.timeoutMs)
    : undefined;
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
        },
        body: JSON.stringify({
          model: request.model,
          messages: [{ role: "user", content: request.prompt }],
          ...(request.effort ? { reasoning_effort: request.effort } : {}),
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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const usage = body.usage ?? {};
    return {
      text: body.choices?.[0]?.message?.content ?? "",
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
function retryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds)
    ? seconds * 1000
    : Math.max(0, Date.parse(value) - Date.now());
}
