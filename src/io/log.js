const process = /** @type {any} */ (globalThis).process;
export function log(level, event, fields = {}) {
  const values = Object.entries(fields).map(([key, value]) =>
    `${key}=${String(value).replace(/\s+/g, "_")}`
  ).join(" ");
  process.stderr.write(
    `${new Date().toISOString()} ${level} ${event}${
      values ? ` ${values}` : ""
    }\n`,
  );
}
