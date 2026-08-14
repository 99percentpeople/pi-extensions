import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Resolve dependencies from an extension's physical package location.
 *
 * pnpm exposes a package through a top-level symlink while linking its direct
 * dependencies beside the physical package in the virtual store. Pi's loader
 * imports the symlink path, so a require rooted there cannot see those links.
 */
export function createRealpathRequire(
  moduleUrl: string,
): ReturnType<typeof createRequire> {
  return createRequire(realpathSync(fileURLToPath(moduleUrl)));
}
