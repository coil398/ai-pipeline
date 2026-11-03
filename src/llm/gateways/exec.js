import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** @param {{argv:string[],limitPatterns?:string[],timeoutMs?:number,outputFile?:string}} gateway @param {{model:string,effort?:string,prompt:string,attemptDir?:string}} request */
export async function execGateway(gateway, request) {
  const temporaryAttemptDir = request.attemptDir
    ? undefined
    : await mkdtemp(path.join(os.tmpdir(), "aip-exec-"));
  const attemptDir = request.attemptDir ?? temporaryAttemptDir;
  const workdir = path.resolve(attemptDir, "work");
  await mkdir(workdir, { recursive: true });
  const argv = gateway.argv.map((value) =>
    value.replaceAll("{model}", request.model).replaceAll(
      "{effort}",
      request.effort ?? "",
    ).replaceAll("{workdir}", workdir)
  );
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: workdir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", async (code) => {
        const output = `${stdout}\n${stderr}`;
        if (
          (gateway.limitPatterns ?? []).some((pattern) =>
            output.includes(pattern)
          )
        ) {
          const error = /** @type {any} */ (new Error(
            "limit: CLI output matched limitPatterns",
          ));
          error.kind = "limit";
          return reject(error);
        }
        if (code !== 0) {
          return reject(new Error(`exec gateway exited ${code}: ${stderr}`));
        }
        let text = stdout;
        if (gateway.outputFile) {
          try {
            const fileText = await readFile(
              path.resolve(workdir, gateway.outputFile),
              "utf8",
            );
            if (fileText.length > 0) text = fileText;
          } catch (error) {
            if (error.code !== "ENOENT") return reject(error);
          }
        }
        resolve({
          text,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
      });
      child.stdin.end(request.prompt);
    });
  } finally {
    if (temporaryAttemptDir) {
      await rm(temporaryAttemptDir, { recursive: true, force: true });
    }
  }
}
