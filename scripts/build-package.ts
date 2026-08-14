import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

interface PackageManifest {
  name?: string;
  private?: boolean;
  main?: string;
  types?: string;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pi?: {
    extensions?: string[];
    [key: string]: unknown;
  };
  piBuild?: {
    assets?: string[];
    bundlePackages?: string[];
  };
  [key: string]: unknown;
}

const workspaceRoot = resolve(import.meta.dir, "..");
const packageDir = process.cwd();
const packageSlug = basename(packageDir);
const manifestPath = resolve(packageDir, "package.json");
const entrypoint = resolve(packageDir, "index.ts");
const rootOutdir = resolve(workspaceRoot, "dist");
const outdir = resolve(rootOutdir, packageSlug);
const legacyOutdir = resolve(packageDir, "dist");
const temporaryOutdir = resolve(
  rootOutdir,
  `.${packageSlug}-${process.pid}-${crypto.randomUUID()}`,
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;

function isInside(root: string, value: string): boolean {
  const fromRoot = relative(root, value);
  return fromRoot === "" || (
    fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  );
}

function validatePackageDirectory(): void {
  const extensionsRoot = resolve(workspaceRoot, "extensions");
  const packagesRoot = resolve(workspaceRoot, "packages");
  const parent = dirname(packageDir);
  if (parent !== extensionsRoot && parent !== packagesRoot) {
    throw new Error(
      `Package builds must run from a direct child of extensions/ or packages/: ${packageDir}`,
    );
  }
  if (!isInside(rootOutdir, outdir) || !isInside(rootOutdir, temporaryOutdir)) {
    throw new Error(`Invalid root build destination for ${packageDir}`);
  }
}

function validateBundlePackages(): void {
  const dependencies = manifest.dependencies ?? {};
  for (const packageName of manifest.piBuild?.bundlePackages ?? []) {
    if (!packageName || !(packageName in dependencies)) {
      throw new Error(
        `Bundled package must be declared in dependencies for ${manifest.name ?? packageSlug}: ${packageName}`,
      );
    }
  }
}

function getExternalPackages(): string[] {
  const bundledPackages = new Set(manifest.piBuild?.bundlePackages ?? []);
  const packageNames = new Set([
    ...Object.keys(manifest.dependencies ?? {}).filter(
      (packageName) => !bundledPackages.has(packageName),
    ),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  return [...packageNames].flatMap((packageName) => [packageName, `${packageName}/*`]);
}

function validateAsset(asset: string): string {
  if (!asset || isAbsolute(asset)) {
    throw new Error(`Build asset must be a non-empty relative path: ${asset}`);
  }
  const source = resolve(packageDir, asset);
  if (!isInside(packageDir, source)) {
    throw new Error(`Build asset escapes the package directory: ${asset}`);
  }
  const destination = resolve(temporaryOutdir, asset);
  if (!isInside(temporaryOutdir, destination)) {
    throw new Error(`Build asset escapes the staging directory: ${asset}`);
  }
  return source;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute).split(sep).join("/"));
    }
  }
  return files;
}

async function emitDeclarations(): Promise<void> {
  const configPath = resolve(packageDir, "tsconfig.build.json");
  if (!(await pathExists(configPath))) return;

  const child = Bun.spawn([
    process.execPath,
    "x",
    "tsc",
    "-p",
    configPath,
    "--outDir",
    temporaryOutdir,
    "--declarationMap",
    "false",
  ], {
    cwd: packageDir,
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Declaration build failed for ${manifest.name ?? packageSlug}`);
  }
}

function createPublishManifest(files: string[]): PackageManifest {
  const publishManifest = structuredClone(manifest);
  delete publishManifest.private;
  delete publishManifest.scripts;
  delete publishManifest.piBuild;

  for (const packageName of manifest.piBuild?.bundlePackages ?? []) {
    delete publishManifest.dependencies?.[packageName];
  }
  if (publishManifest.dependencies && Object.keys(publishManifest.dependencies).length === 0) {
    delete publishManifest.dependencies;
  }

  publishManifest.files = files.filter((file) => file !== "package.json").sort();
  if (publishManifest.pi?.extensions) {
    if (
      publishManifest.pi.extensions.length !== 1
      || publishManifest.pi.extensions[0] !== "./index.ts"
    ) {
      throw new Error(
        `${manifest.name ?? packageSlug} must declare its source extension as ./index.ts`,
      );
    }
    publishManifest.pi.extensions = ["./index.min.js"];
  }
  if (publishManifest.main !== undefined) publishManifest.main = "./index.min.js";
  if (publishManifest.types !== undefined) publishManifest.types = "./index.d.ts";
  return publishManifest;
}

if (!manifest.name) throw new Error(`${manifestPath} has no package name`);
validatePackageDirectory();
validateBundlePackages();

await mkdir(rootOutdir, { recursive: true });
await rm(temporaryOutdir, { recursive: true, force: true });
await rm(legacyOutdir, { recursive: true, force: true });
await mkdir(temporaryOutdir, { recursive: true });

try {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: temporaryOutdir,
    root: packageDir,
    target: "node",
    format: "esm",
    // Runtime dependencies and Pi-provided peers remain external by default.
    // Packages explicitly listed in piBuild.bundlePackages are compiled into
    // the single-file extension and removed from the publish manifest.
    external: getExternalPackages(),
    naming: "[name].min.[ext]",
    sourcemap: "linked",
    minify: true,
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Failed to build ${manifest.name}`);
  }

  const runtimeEntry = resolve(temporaryOutdir, "index.min.js");
  const sourceMap = `${runtimeEntry}.map`;
  if (!(await pathExists(runtimeEntry)) || !(await pathExists(sourceMap))) {
    throw new Error(`Build for ${manifest.name} did not produce index.min.js and its map`);
  }

  await emitDeclarations();

  const assets = new Set(["README.md", "LICENSE", ...(manifest.piBuild?.assets ?? [])]);
  for (const asset of assets) {
    const source = validateAsset(asset);
    if (!(await pathExists(source))) {
      throw new Error(`Build asset does not exist for ${manifest.name}: ${asset}`);
    }
    const destination = resolve(temporaryOutdir, asset);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  }

  const files = await listFiles(temporaryOutdir);
  const publishManifest = createPublishManifest(files);
  await writeFile(
    resolve(temporaryOutdir, "package.json"),
    `${JSON.stringify(publishManifest, null, 2)}\n`,
    "utf8",
  );

  await rm(outdir, { recursive: true, force: true });
  await rename(temporaryOutdir, outdir);
} catch (error) {
  await rm(temporaryOutdir, { recursive: true, force: true });
  throw error;
}

console.log(
  `Built ${manifest.name} -> ${relative(workspaceRoot, outdir).split(sep).join("/")}/index.min.js`,
);
