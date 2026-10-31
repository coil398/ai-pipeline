import { spawn } from "node:child_process";

/** @param {{argv:string[],limitPatterns?:string[],timeoutMs?:number}} gateway @param {{model:string,effort?:string,prompt:string}} request */
export function execGateway(gateway, request) {
  const argv = gateway.argv.map((value) =>
    value.replaceAll("{model}", request.model).replaceAll(
      "{effort}",
      request.effort ?? "",
    )
  );
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
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
    child.on("close", (code) => {
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
      resolve({
        text: stdout,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
    });
    child.stdin.end(request.prompt);
  });
}
