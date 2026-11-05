import os from "node:os";
import path from "node:path";
import { openaiChat } from "./gateways/openai-chat.js";
import { execGateway } from "./gateways/exec.js";
import { atomicJson, exists, readJson } from "../io/files.js";
import { log } from "../io/log.js";

const DEFAULT_COOLDOWN = 60 * 60 * 1000;
const activeCalls = new Map();
const cooldownPath = () =>
  process.env.AIP_COOLDOWN_PATH ??
    path.join(os.homedir(), ".cache", "ai-pipeline", "cooldown.json");

/** @param {{route:string,prompt:string,routes:Record<string,Array<{gateway:string,model:string,effort?:string}>>,gateways:Record<string,any>,attemptDir?:string}} options */
export async function routeLlm({ route, prompt, routes, gateways, fallbacks = {}, attemptDir }) {
  const routeEntries = routes[route];
  const entries = routeEntries?.length
    ? expandRouteEntries(routeEntries, fallbacks)
    : routeEntries;
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
      const waitMs = Math.max(0, next - Date.now());
      log("WARN", "route_wait", {
        route,
        cooldowns: entries.map((entry) =>
          `${entry.gateway}=${new Date(cooldowns[entry.gateway] ?? 0).toISOString()}`
        ).join(","),
        waitMs,
      });
      await delay(waitMs);
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
        log("WARN", "gateway_limited", {
          gateway: entry.gateway,
          model: entry.model,
          cooldownUntil: new Date(cooldowns[entry.gateway]).toISOString(),
        });
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

export function expandRouteEntries(entries, fallbacks) {
  const expanded = [];
  const seen = new Set();
  for (const entry of entries) {
    const alternatives = fallbacks[`${entry.gateway}:${entry.model}`] ?? [];
    for (const candidate of [entry, ...alternatives.map((alternative) => ({
      ...alternative,
      effort: alternative.effort ?? entry.effort,
    }))]) {
      const key = JSON.stringify([candidate.gateway, candidate.model, candidate.effort]);
      if (!seen.has(key)) {
        seen.add(key);
        expanded.push(candidate);
      }
    }
  }
  return expanded;
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
