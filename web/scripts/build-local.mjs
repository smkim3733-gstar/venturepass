import { spawn } from "node:child_process";
import { cp, lstat, mkdtemp, realpath, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredNames = new Set([".git", ".next", ".venture-pass", "node_modules", "coverage"]);
const sourceDirectories = ["src", "public", "scripts"];
const sourceFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".gitignore",
  "next.config.ts",
  "tsconfig.json",
  "next-env.d.ts",
  "postcss.config.mjs",
  "eslint.config.mjs",
  "vitest.config.ts",
  "components.json",
  // These are repository fixtures. Local application data is never copied.
  "data/venture-summary.json",
  "data/venture-companies.json",
];

function within(directory, parent) {
  const relative = path.relative(parent, directory);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function unsyncedTemporaryRoot() {
  const temporaryRoot = await realpath(tmpdir());
  const syncedRoots = Object.entries(process.env)
    .filter(([key, value]) => /^OneDrive(?:Consumer|Commercial)?$/i.test(key) && value)
    .map(([, value]) => value);
  for (const syncedRoot of syncedRoots) {
    const resolved = await realpath(syncedRoot).catch(() => path.resolve(syncedRoot));
    if (within(temporaryRoot, resolved))
      throw new Error(
        "The temporary directory is inside OneDrive. Choose a local TEMP directory first.",
      );
  }
  if (temporaryRoot.split(path.sep).some((segment) => /^OneDrive(?:\s*-\s*.+)?$/i.test(segment)))
    throw new Error(
      "The temporary directory is inside OneDrive. Choose a local TEMP directory first.",
    );
  return temporaryRoot;
}

async function allowedSource(source) {
  const name = path.basename(source);
  if (ignoredNames.has(name) || name.startsWith(".env") || name.startsWith(".next-")) return false;
  // Do not copy linked user data or follow a link outside the allowlisted source trees.
  if ((await lstat(source)).isSymbolicLink())
    throw new Error("A source tree contains a symbolic link. Local build staging was stopped.");
  return true;
}

async function verifySourceFile(sourceRoot, relativeFile) {
  let current = sourceRoot;
  for (const segment of relativeFile.split(/[\\/]/)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error(
        "An allowlisted file has a linked parent or target. Local build staging was stopped.",
      );
  }
  if (!within(await realpath(current), sourceRoot))
    throw new Error("An allowlisted file resolves outside the source directory.");
}

export function localBuildEnvironment(staging, inherited = process.env) {
  const environment = { ...inherited };
  for (const key of Object.keys(environment)) {
    if (/^OPENAI_/i.test(key) || /^VENTURE_DATA_DIR$/i.test(key)) delete environment[key];
  }
  return {
    ...environment,
    VENTURE_DATA_DIR: path.join(staging, ".venture-pass-build-data"),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

export async function prepareLocalBuild(source = projectDirectory) {
  const sourceRoot = await realpath(source);
  const dependencyRoot = await realpath(path.join(sourceRoot, "node_modules"));
  const nextCli = await realpath(path.join(dependencyRoot, "next", "dist", "bin", "next"));
  const temporaryRoot = await unsyncedTemporaryRoot();
  if (within(temporaryRoot, sourceRoot))
    throw new Error("The temporary directory must be outside the application source directory.");
  const staging = await mkdtemp(path.join(temporaryRoot, "venturepass-build-"));
  const stagingReal = await realpath(staging);
  if (!within(stagingReal, temporaryRoot) || stagingReal === temporaryRoot)
    throw new Error("The build staging directory could not be verified.");

  for (const directory of sourceDirectories) {
    await cp(path.join(sourceRoot, directory), path.join(stagingReal, directory), {
      recursive: true,
      filter: allowedSource,
      errorOnExist: true,
      force: false,
    });
  }
  for (const file of sourceFiles) {
    const origin = path.join(sourceRoot, file);
    try {
      await stat(origin);
    } catch (error) {
      if (error.code === "ENOENT" && file === "next-env.d.ts") continue;
      throw error;
    }
    await verifySourceFile(sourceRoot, file);
    await cp(origin, path.join(stagingReal, file), { filter: allowedSource });
  }
  await symlink(
    dependencyRoot,
    path.join(stagingReal, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return { staging: stagingReal, nextCli };
}

export async function runLocalBuild({ prepareOnly = false } = {}) {
  const { staging, nextCli } = await prepareLocalBuild();
  console.log(`Local build staging: ${staging}`);
  if (prepareOnly) return 0;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nextCli, "build", "--webpack"], {
      cwd: staging,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
      env: localBuildEnvironment(staging),
    });
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code === 0) console.log(`Production build output: ${path.join(staging, ".next")}`);
  else console.error(`Build did not finish successfully. Staging retained: ${staging}`);
  return code;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--prepare-only")) {
    console.error("Usage: node scripts/build-local.mjs [--prepare-only]");
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = await runLocalBuild({ prepareOnly: args.includes("--prepare-only") });
    } catch (error) {
      console.error(`Local build setup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
