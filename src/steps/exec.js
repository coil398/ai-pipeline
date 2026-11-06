import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";

export async function runExec({ argv, cwd, env, stderrFile }) {
  await writeFile(stderrFile, "");
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "inherit", "pipe"],
    });
    let stderrTail = "";
    const stderrStream = createWriteStream(stderrFile, { flags: "a" });
    const stderrDone = finished(stderrStream).catch((error) => error);
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-500);
    });
    child.stderr.pipe(stderrStream);
    child.on("error", reject);
    child.on("close", async (code) => {
      const writeError = await stderrDone;
      if (writeError) return reject(writeError);
      if (code !== 0) {
        const tail = stderrTail;
        reject(new Error(
          `exec exited ${code}: ${argv[0]}${tail ? `: ${tail}` : ""}; stderr log: ${stderrFile}`,
        ));
      }
      else resolve();
    });
  });
}
