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
export async function routeLlm({ route, prompt, routes, gateways, fallbacks = {}, attemptDir, now = () => Date.now() }) {
  const routeEntries = routes[route];
  let entries = routeEntries?.length
    ? expandRouteEntries(routeEntries, fallbacks)
    : routeEntries;
  if (!entries?.length) throw new Error(`unknown route: ${route}`);
  const originalEntries = entries;
  const callTime = now();
  const reordered = entries.filter((entry) => !isPeak(gateways[entry.gateway]?.peakHours, callTime))
    .concat(entries.filter((entry) => isPeak(gateways[entry.gateway]?.peakHours, callTime)));
  if (reordered[0] !== originalEntries[0]) {
    log("INFO", "route_offpeak_order", {
      route,
      gateways: reordered.map((entry) => entry.gateway).join(","),
    });
  }
  entries = reordered;
  const tried = [];
  const transientEntries = new Set();
  let lastTransientError;
  for (;;) {
    const cooldowns = await loadCooldowns();
    const available = entries.filter((entry) =>
      (cooldowns[entry.gateway] ?? 0) <= Date.now() &&
      !transientEntries.has(entryKey(entry))
    );
    if (!available.length) {
      const cooling = entries.filter((entry) => (cooldowns[entry.gateway] ?? 0) > Date.now());
      if (!cooling.length && lastTransientError) {
        lastTransientError.tried = tried;
        throw lastTransientError;
      }
      const next = Math.min(
        ...cooling.map((entry) => cooldowns[entry.gateway]),
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
        if (error.kind === "transient") {
          transientEntries.add(entryKey(entry));
          lastTransientError = error;
          tried.push({
            gateway: entry.gateway,
            model: entry.model,
            effort: entry.effort,
            result: "transient",
            error: error.message,
          });
          log("WARN", "gateway_transient", {
            gateway: entry.gateway,
            model: entry.model,
            error: error.message,
          });
          continue;
        }
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

function entryKey(entry) {
  return JSON.stringify([entry.gateway, entry.model, entry.effort]);
}

export function isPeak(peakHours, dateOrMillis) {
  if (!peakHours?.length) return false;
  const date = dateOrMillis instanceof Date ? dateOrMillis : new Date(dateOrMillis);
  const day = date.getUTCDay();
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return peakHours.some(({ days, start, end }) => {
    const startMinute = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
    const endMinute = Number(end.slice(0, 2)) * 60 + Number(end.slice(3));
    return startMinute < endMinute
      ? days.includes(day) && minute >= startMinute && minute < endMinute
      : minute >= startMinute && days.includes(day) || minute < endMinute && days.includes((day + 6) % 7);
  });
}

export function validatePeakHours(gateways) {
  for (const [name, gateway] of Object.entries(gateways)) {
    if (gateway.peakHours === undefined) continue;
    if (!Array.isArray(gateway.peakHours)) throw new Error(`gateway ${name} peakHours must be an array`);
    for (const window of gateway.peakHours) {
      if (!window || typeof window !== "object" || Array.isArray(window) ||
        !Array.isArray(window.days) ||
        window.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
        !validUtcTime(window.start) || !validUtcTime(window.end)) {
        throw new Error(`invalid peakHours for gateway ${name}`);
      }
    }
  }
}

function validUtcTime(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
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
