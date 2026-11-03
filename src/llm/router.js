import os from "node:os";
import path from "node:path";
import { openaiChat } from "./gateways/openai-chat.js";
import { execGateway } from "./gateways/exec.js";
import { piGateway } from "./gateways/pi.js";
import { atomicJson, exists, readJson } from "../io/files.js";

const DEFAULT_COOLDOWN = 60 * 60 * 1000;
const activeCalls = new Map();
const cooldownPath = () =>
  process.env.AIP_COOLDOWN_PATH ??
    path.join(os.homedir(), ".cache", "ai-pipeline", "cooldown.json");

/** @param {{route:string,prompt:string,routes:Record<string,Array<{gateway:string,model:string,effort?:string}>>,gateways:Record<string,any>,attemptDir?:string,gatewaysDir?:string,runDir?:string}} options */
export async function routeLlm({ route, prompt, routes, gateways, attemptDir, gatewaysDir, runDir }) {
  const entries = routes[route];
  if (!entries?.length) throw new Error(`unknown route: ${route}`);
  const tried = [];
  for (;;) {
    const cooldowns = await loadCooldowns();
    const available = entries.filter((entry) =>
      (cooldowns[entry.gateway] ?? 0) <= Date.now()
    );
    if (!available.length) {
      const next = Math.min(
        ...entries.map((entry) => cooldowns[entry.gateway] ?? 0),
      );
      await delay(Math.max(0, next - Date.now()));
      continue;
    }
    for (const entry of available) {
      const gateway = gateways[entry.gateway];
      if (!gateway) throw new Error(`unknown gateway: ${entry.gateway}`);
      try {
        const result = gateway.kind === "openai-chat"
          ? await withParallel(
            entry.gateway,
            gateway.maxParallel,
            () => openaiChat(gateway, { ...entry, prompt }),
          )
          : gateway.kind === "exec"
          ? await withParallel(
            entry.gateway,
            gateway.maxParallel,
            () => execGateway(gateway, { ...entry, prompt, attemptDir }),
          )
          : gateway.kind === "pi"
          ? await withParallel(
            entry.gateway,
            gateway.maxParallel,
            () => piGateway(gateway, {
              ...entry,
              prompt,
              attemptDir,
              gatewaysDir,
              runDir,
              gatewayId: entry.gateway,
            }),
          )
          : (() => {
            throw new Error(`unsupported gateway kind: ${gateway.kind}`);
          })();
        tried.push({
          gateway: entry.gateway,
          model: entry.model,
          effort: entry.effort,
          result: "success",
        });
        return {
          ...result,
          gateway: entry.gateway,
          model: entry.model,
          effort: entry.effort,
          tried,
        };
      } catch (error) {
        if (error.kind !== "limit") {
          tried.push({
            gateway: entry.gateway,
            model: entry.model,
            effort: entry.effort,
            result: "failed",
            error: error.message,
          });
          error.tried = tried;
          throw error;
        }
        const duration = error.retryAfterMs ?? gateway.cooldownMs ??
          DEFAULT_COOLDOWN;
        cooldowns[entry.gateway] = Date.now() + duration;
        await atomicJson(cooldownPath(), cooldowns);
        tried.push({
          gateway: entry.gateway,
          model: entry.model,
          effort: entry.effort,
          result: "limit",
          retryAfterMs: error.retryAfterMs,
        });
      }
    }
  }
}
async function loadCooldowns() {
  const file = cooldownPath();
  return await exists(file) ? readJson(file) : {};
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withParallel(id, limit, action) {
  if (!limit || limit < 1) return action();
  const current = activeCalls.get(id) ?? { count: 0, waiting: [] };
  if (current.count >= limit) {
    await new Promise((resolve) => current.waiting.push(resolve));
  }
  current.count += 1;
  activeCalls.set(id, current);
  try {
    return await action();
  } finally {
    current.count -= 1;
    current.waiting.shift()?.();
  }
}
