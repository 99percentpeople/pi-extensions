# @99percentpeople/pi-workspace-files

Composable binary workspace file-system protocol for Pi extensions.

A consumer requests the active workspace backend. If no extension claims the
request, the package returns a local Node.js file system constrained to Pi's
current workspace. Providers such as `@99percentpeople/pi-ssh-remote` can claim
the request and route the same operations to Unix or Windows workspaces.

The interface supports:

- platform-aware path resolution, extension lookup, and parent directories;
- buffered or streaming binary reads and writes through the same methods;
- recursive directory creation;
- existence checks for overwrite protection;
- `AbortSignal` propagation;
- rejection when multiple providers claim one workspace.

## Consumer

```ts
import {
  collectWorkspaceFile,
  resolveWorkspaceFiles,
} from "@99percentpeople/pi-workspace-files";

const files = resolveWorkspaceFiles(pi, ctx.cwd);
const output = files.resolvePath("output/image.png");
const options = { signal };
if (await files.exists(output, options)) throw new Error("Already exists");
await files.mkdir(files.dirname(output), options);

// Buffer/Uint8Array and AsyncIterable<Uint8Array> use the same method.
await files.writeFile(output, pngBytesOrChunks, options);

// Consumers that need a Buffer can collect either provider representation.
const bytes = await collectWorkspaceFile(
  await files.readFile(output, options),
  options,
);
```

## Provider

```ts
import {
  registerWorkspaceFileProvider,
  type WorkspaceFileSystem,
} from "@99percentpeople/pi-workspace-files";

registerWorkspaceFileProvider(pi, "my-remote-extension", ({ cwd }) => {
  if (!remoteIsActive()) return undefined;
  return createRemoteFiles(cwd) satisfies WorkspaceFileSystem;
});
```

`readFile` and `writeFile` deliberately cover both buffered and streaming data;
providers do not need separate stream-specific methods. Existing providers may
return `Uint8Array`, while large-file providers can return an
`AsyncIterable<Uint8Array>`. Cancellation and future transfer controls live in
one optional `WorkspaceFileOptions` object instead of positional parameters.

This package is installed automatically as a dependency. It is not a Pi
extension and does not declare a `pi.extensions` entry.

## License

MIT
