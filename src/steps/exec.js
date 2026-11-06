import { spawn } from "node:child_process";

export function runExec({ argv, cwd, env, stderrFile }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "inherit", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(stderrFile, stderr);
      if (code !== 0) {
        const tail = stderr.slice(-500);
        reject(new Error(
          `exec exited ${code}: ${argv[0]}${tail ? `: ${tail}` : ""}; stderr log: ${stderrFile}`,
        ));
      }
      else resolve();
    });
  });
}
