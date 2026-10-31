declare const process: { env: Record<string, string | undefined> };
declare module "node:path" {
  const path: any;
  export default path;
}
declare module "node:os" {
  const os: any;
  export default os;
}
declare module "node:fs/promises" {
  export const mkdir: any;
  export const readFile: any;
  export const rename: any;
  export const writeFile: any;
  export const copyFile: any;
  export const access: any;
  export const randomUUID: any;
  export const open: any;
  export const unlink: any;
  export const readdir: any;
}
declare module "node:crypto" {
  export const randomUUID: any;
}
declare module "node:child_process" {
  export const spawn: any;
}
