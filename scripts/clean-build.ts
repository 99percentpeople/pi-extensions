import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dir, "..");

await rm(resolve(workspaceRoot, "dist"), { recursive: true, force: true });

for (const group of ["extensions", "packages"]) {
  const root = resolve(workspaceRoot, group);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await rm(resolve(root, entry.name, "dist"), { recursive: true, force: true });
  }
}
