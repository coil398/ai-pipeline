import { readFile, writeFile } from "node:fs/promises"; const m = JSON.parse(await readFile(process.env.AIP_MANIFEST, "utf8")); await writeFile(m.outputs.screenshots, "captured\\n");
