import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

interface PackageManifest {
  name?: string;
  piBuild?: {
    assets?: string[];
  };
}

const packageDir = process.cwd();
const manifestPath = resolve(packageDir, "package.json");
const entrypoint = resolve(packageDir, "index.ts");
const outdir = resolve(packageDir, "dist");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;

if (!manifest.name) {
  throw new Error(`${manifestPath} has no package name`);
}

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [entrypoint],
  outdir,
  root: packageDir,
  target: "node",
  format: "esm",
  packages: "external",
  sourcemap: "linked",
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error(`Failed to build ${manifest.name}`);
}

for (const asset of manifest.piBuild?.assets ?? []) {
  if (isAbsolute(asset)) {
    throw new Error(`Build asset must be relative to the package: ${asset}`);
  }

  const source = resolve(packageDir, asset);
  const sourceRelativePath = relative(packageDir, source);
  if (sourceRelativePath.startsWith("..") || isAbsolute(sourceRelativePath)) {
    throw new Error(`Build asset escapes the package directory: ${asset}`);
  }

  const destination = resolve(outdir, asset);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

console.log(`Built ${manifest.name} -> ${relative(packageDir, outdir)}/index.js`);
