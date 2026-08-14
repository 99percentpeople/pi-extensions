import { createRealpathRequire } from "./realpath-require.ts";

const runtimeRequire = createRealpathRequire(import.meta.url);

type NodePtyModule = typeof import("node-pty");
type XtermHeadlessModule = typeof import("@xterm/headless");
type XtermSerializeModule = typeof import("@xterm/addon-serialize");

export const nodePty = runtimeRequire("node-pty") as NodePtyModule;
export const { Terminal: HeadlessTerminal } = runtimeRequire(
  "@xterm/headless",
) as XtermHeadlessModule;
export const { SerializeAddon } = runtimeRequire(
  "@xterm/addon-serialize",
) as XtermSerializeModule;
