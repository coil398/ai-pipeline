import path from "node:path";
import { writeFile } from "node:fs/promises";
import { exists, readText } from "../../io/files.js";

export async function humanGateway(
  { step, dir, prompt },
) {
  const promptFile = path.join(dir, "prompt.md");
  await writeFile(promptFile, prompt);
  const output = path.join(dir, "output.md");
  if (!await exists(output)) throw new Error("waiting-human");
  return readText(output);
}
