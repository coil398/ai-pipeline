import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
export async function readText(file) {
  return readFile(file, "utf8");
}
export async function readJson(file) {
  return JSON.parse(await readText(file));
}
export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}
export { copyFile };
