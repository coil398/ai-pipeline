import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";

const process = /** @type {any} */ (globalThis).process;
export async function acquireLease(file) {
  const owner = {
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
  };
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(owner));
  try {
    await link(temp, file);
  } catch (error) {
    await unlink(temp);
    if (error.code !== "EEXIST") throw error;
    try {
      const current = JSON.parse(await readFile(file, "utf8"));
      if (current.host === owner.host && Number.isInteger(current.pid)) {
        try {
          process.kill(current.pid, 0);
          // /proc is optional; retain the kill(pid, 0) result when unavailable.
          const stat = await readFile(`/proc/${current.pid}/stat`, "utf8").catch(() => "");
          const commandEnd = stat.lastIndexOf(")");
          if (commandEnd !== -1 && stat.slice(commandEnd + 1).trimStart().startsWith("Z ")) {
            await unlink(file);
            return acquireLease(file);
          }
        } catch (probe) {
          if (probe.code === "ESRCH") {
            await unlink(file);
            return acquireLease(file);
          }
          throw probe;
        }
      }
    } catch (inspectionError) {
      if (inspectionError.code !== "ENOENT") throw inspectionError;
      return acquireLease(file);
    }
    throw new Error(`run is leased: ${file}`);
  }
  await unlink(temp);
  return async () => {
    await unlink(file);
  };
}
