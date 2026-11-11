#!/usr/bin/env -S deno run -A

// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { parseArgs } from "@std/cli/parse-args";
import { expandGlob } from "@std/fs";
import { parse as parseJsonc } from "@std/jsonc";
import { isGlob, join, relative, resolve, SEPARATOR } from "@std/path";

interface CompileOptions {
  output: string;
  target?: string;
  version?: string;
  bundle: boolean;
}

// inside the repo so deno.json resolves the npm externals at the same root
export const BUNDLE_DIR = join("build", "bundle");

export const VERSION_FILE = "src/infrastructure/runtime/build_info.ts";

const VERSION_PATTERN = /export const VERSION = "[^"]+";/;
const GIT_SHA_PATTERN = /export const GIT_SHA = "[^"]*";/;

function replaceConstant(
  content: string,
  name: string,
  pattern: RegExp,
  value: string,
): string {
  if (!pattern.test(content)) {
    throw new Error(`${VERSION_FILE} has no ${name} constant to stamp`);
  }
  return content.replace(pattern, `export const ${name} = "${value}";`);
}

// pure so a failed match throws before anything is written
export function stampBuildInfo(
  content: string,
  stamp: { version?: string; sha?: string },
): string {
  let stamped = content;
  if (stamp.sha) {
    stamped = replaceConstant(stamped, "GIT_SHA", GIT_SHA_PATTERN, stamp.sha);
  }
  if (stamp.version) {
    stamped = replaceConstant(
      stamped,
      "VERSION",
      VERSION_PATTERN,
      stamp.version,
    );
  }
  return stamped;
}

async function getGitSha(root: string): Promise<string> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
      cwd: root,
      stdout: "piped",
      stderr: "null",
    });
    const { success, stdout } = await cmd.output();
    if (!success) return "";
    return new TextDecoder().decode(stdout).trim();
  } catch {
    return "";
  }
}

async function downloadDeno(
  runner: BuildRunner,
  root: string,
  target?: string,
): Promise<boolean> {
  const downloadArgs = ["run", "-A", "scripts/download_deno.ts"];
  if (target) {
    downloadArgs.push("--target", target);
  }

  console.log(`Downloading embedded deno runtime...`);
  if (await runner.run(downloadArgs, root)) return true;
  if (runner.interrupted) return false;
  throw new Error("Failed to download deno binary for embedding");
}

export interface DenoConfig {
  imports?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
  workspace?: string[];
}

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export type ImportSource = DenoConfig | PackageJson;

export function npmExternals(sources: readonly ImportSource[]): string[] {
  const names = new Set<string>();
  for (const source of sources) {
    const deno = source as DenoConfig;
    // a package.json "imports" field can hold condition objects
    const maps = [deno.imports, ...Object.values(deno.scopes ?? {})];
    for (const map of maps) {
      for (
        const [name, target] of Object.entries(
          (map ?? {}) as Record<string, unknown>,
        )
      ) {
        if (typeof target === "string" && target.startsWith("npm:")) {
          names.add(name);
        }
      }
    }
    const pkg = source as PackageJson;
    for (
      const deps of [
        pkg.dependencies,
        pkg.devDependencies,
        pkg.optionalDependencies,
        pkg.peerDependencies,
      ]
    ) {
      for (const name of Object.keys(deps ?? {})) names.add(name);
    }
  }
  return [...names].sort();
}

// an empty list would inline every npm package into the bundle
export function requireNpmExternals(
  { configs, paths }: { configs: readonly ImportSource[]; paths: string[] },
): string[] {
  const externals = npmExternals(configs);
  if (externals.length === 0) {
    throw new Error(
      `No npm imports found in ${paths.join(", ")}; refusing to bundle ` +
        "with every npm package inlined",
    );
  }
  return externals;
}

async function readOptional(path: string): Promise<string | undefined> {
  return await Deno.readTextFile(path).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  });
}

async function memberDirs(root: string, member: string): Promise<string[]> {
  if (!isGlob(member)) return [join(root, member)];
  const dirs: string[] = [];
  for await (const entry of expandGlob(member, { root, includeDirs: true })) {
    if (entry.isDirectory) dirs.push(entry.path);
  }
  return dirs.sort();
}

export async function readWorkspaceConfigs(
  root: string,
): Promise<{ configs: ImportSource[]; paths: string[] }> {
  const configs: ImportSource[] = [];
  const paths: string[] = [];
  const read = async (dir: string): Promise<DenoConfig | undefined> => {
    let denoConfig: DenoConfig | undefined;
    for (const name of ["deno.json", "deno.jsonc"]) {
      const text = await readOptional(join(dir, name));
      if (text === undefined) continue;
      denoConfig = parseJsonc(text) as DenoConfig;
      configs.push(denoConfig);
      paths.push(join(dir, name));
      break;
    }
    const pkg = await readOptional(join(dir, "package.json"));
    if (pkg !== undefined) {
      configs.push(JSON.parse(pkg) as PackageJson);
      paths.push(join(dir, "package.json"));
    }
    return denoConfig;
  };
  const rootConfig = await read(root);
  if (rootConfig === undefined) {
    throw new Error(`No deno.json or deno.jsonc in ${root}`);
  }
  for (const member of rootConfig.workspace ?? []) {
    for (const dir of await memberDirs(root, member)) await read(dir);
  }
  return { configs, paths };
}

// relative() yields an absolute path across Windows drives
function isOutside(rel: string, path: string): boolean {
  return rel === ".." || rel.startsWith(`..${SEPARATOR}`) || rel === path;
}

function packageAt(segments: readonly string[]): string | undefined {
  const [first, second] = segments;
  if (first === undefined || first.startsWith(".")) return undefined;
  if (!first.startsWith("@")) return first;
  return second === undefined ? undefined : `${first}/${second}`;
}

// a source under <npmCache>/<any registry host>/ or node_modules was inlined
export function inlinedNpmPackages(
  sources: readonly string[],
  { bundleDir, npmCache }: { bundleDir: string; npmCache: string },
): string[] {
  const names = new Set<string>();
  for (const source of sources) {
    const path = resolve(bundleDir, source);
    const inCache = relative(npmCache, path);
    const name = !isOutside(inCache, path)
      ? packageAt(inCache.split(SEPARATOR).slice(1))
      : nodeModulesPackage(path);
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

// sources that are not repo paths would make the inlined check pass blind
export function requireRepoSources(
  sources: readonly string[],
  { bundleDir, root }: { bundleDir: string; root: string },
): void {
  const within = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel !== "" && !isOutside(rel, path);
  };
  // a URL or specifier resolves to a junk path under the bundle dir itself
  const inRepo = sources.some((source) => {
    const path = resolve(bundleDir, source);
    return within(root, path) && !within(bundleDir, path);
  });
  if (!inRepo) {
    throw new Error(
      "No source-map source resolves inside the repo, so the check for " +
        "inlined npm packages cannot run",
    );
  }
}

function nodeModulesPackage(path: string): string | undefined {
  const segments = path.split(SEPARATOR);
  const at = segments.lastIndexOf("node_modules");
  return at === -1 ? undefined : packageAt(segments.slice(at + 1));
}

async function npmCacheDir(root: string): Promise<string> {
  const { success, stdout } = await new Deno.Command("deno", {
    args: ["info", "--json"],
    cwd: root,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  const npmCache = success
    ? (JSON.parse(new TextDecoder().decode(stdout)) as { npmCache?: unknown })
      .npmCache
    : undefined;
  if (typeof npmCache !== "string") {
    throw new Error("deno info --json did not report the npm cache directory");
  }
  return npmCache;
}

export function bundleArgs(
  outDir: string,
  externals: readonly string[],
): string[] {
  return [
    "bundle",
    "--platform",
    "deno",
    "--format",
    "esm",
    "--code-splitting",
    // telemetry and serve read error.constructor.name, which esbuild renames
    "--keep-names",
    "--sourcemap=linked",
    "--outdir",
    outDir,
    // the = form, since a bare --external would swallow the entry
    ...externals.map((name) => `--external=${name}`),
    "main.ts",
  ];
}

// Deno applies a linked map only when it is included
export function sourceMapIncludes(
  outDir: string,
  fileNames: readonly string[],
): string[] {
  return fileNames
    .filter((name) => name.endsWith(".map"))
    .sort()
    .flatMap((name) => ["--include", join(outDir, name)]);
}

export interface StampedBuildSteps {
  stamp: () => Promise<void>;
  build: () => Promise<boolean>;
  restore: () => Promise<void>;
}

export async function runStampedBuild(
  steps: StampedBuildSteps,
): Promise<boolean> {
  try {
    await steps.stamp();
    return await steps.build();
  } finally {
    await steps.restore();
  }
}

// never throws, so one failed removal cannot skip the next
async function removeBuildDir(dir: string, label: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
    console.log(`Cleaned up ${label}`);
  } catch {
    // Directory may not exist — that's fine
  }
}

// undefined content or bundleDir means there is nothing there to restore
export async function restoreBuildState(
  versionFile: string,
  originalContent: string | undefined,
  denoResourcesDir: string,
  bundleDir: string | undefined,
): Promise<void> {
  try {
    if (originalContent !== undefined) {
      await Deno.writeTextFile(versionFile, originalContent);
    }
  } finally {
    await removeBuildDir(denoResourcesDir, "resources/deno/");
    if (bundleDir !== undefined) {
      await removeBuildDir(bundleDir, "build/bundle/");
    }
  }
}

async function main(): Promise<boolean> {
  const args = parseArgs(Deno.args, {
    string: ["output", "target", "version"],
    boolean: ["bundle"],
    alias: {
      "o": "output",
      "t": "target",
      "v": "version",
    },
    default: {
      "output": "swamp",
    },
  });

  // every path below is the repo root's, so the script runs from any directory
  const root = await Deno.realPath(join(import.meta.dirname ?? ".", ".."));
  const versionFile = join(root, VERSION_FILE);
  const options: CompileOptions = {
    output: resolve(args.output || "swamp"),
    target: args.target,
    version: args.version,
    bundle: args.bundle,
  };

  // stamp the version only when given (CI passes --version); dev builds keep
  // the source default, so the original is saved to restore after compile
  const originalContent = await Deno.readTextFile(versionFile);
  const sha = await getGitSha(root);
  const stamped = stampBuildInfo(originalContent, {
    version: options.version,
    sha,
  });
  if (sha) {
    console.log(`Git SHA: ${sha}`);
  }
  if (options.version) {
    console.log(`Version: ${options.version}`);
  } else {
    console.log(
      "No --version provided; using source-default version (dev build)",
    );
  }
  const wroteStamp = stamped !== originalContent;

  const runner = new BuildRunner();
  return await withInterruptGuard(runner, () =>
    runStampedBuild({
      stamp: async () => {
        if (wroteStamp) {
          await Deno.writeTextFile(versionFile, stamped);
        }
      },
      build: () => compile(runner, options, root),
      restore: () =>
        restoreBuildState(
          versionFile,
          wroteStamp ? originalContent : undefined,
          join(root, "resources", "deno"),
          options.bundle ? join(root, BUNDLE_DIR) : undefined,
        ),
    }));
}

export interface CompileInputs {
  entry: string;
  dashboardDistExists: boolean;
  extraIncludes: readonly string[];
}

export function compileArgs(
  options: { output: string; target?: string },
  inputs: CompileInputs,
): string[] {
  // individual flags, not --allow-all, to avoid auto-granting future
  // permission categories; Deno.open on device nodes then fails, so
  // extensions use Deno.Command for hardware I/O
  const args = [
    "compile",
    "--unstable-bundle",
    // Deno marks listening with SO_REUSEPORT unstable; serve --reuse-port needs it
    "--unstable-net",
    // the dashboard's build packages stay in the workspace but never ship
    "--exclude-unused-npm",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-run",
    "--allow-sys",
    "--allow-net",
    // ffi is for libc/libproc calls: raising the fd limit, the auth gate's
    // ancestry check, and /proc and sysctl reads for writer liveness.
    "--allow-ffi",
    "--include",
    ".claude/skills",
    "--include",
    "resources/deno",
    // included only when pre-built; CI builds it before compile
    ...(inputs.dashboardDistExists
      ? ["--include", "packages/dashboard/dist"]
      : []),
    ...inputs.extraIncludes,
    "--exclude",
    "agent-constraints",
    "--exclude",
    ".agents",
    "--exclude",
    ".claude/skills/ddd",
    "--exclude",
    ".claude/skills/github-pr",
    "--exclude",
    ".claude/skills/jujutsu",
    "--exclude",
    ".claude/skills/issue-lifecycle",
    "--exclude",
    ".claude/skills/skill-creator",
    "--exclude",
    ".claude/skills/terminal-output",
    "--exclude",
    ".github",
    "--exclude",
    ".vault-test-vault",
    "--exclude",
    "design",
    "--exclude",
    "evals",
    "--exclude",
    "integration",
    "--exclude",
    "scripts",
    "--exclude",
    "verification",
    "--exclude",
    "workflows",
  ];

  if (options.target) {
    args.push("--target", options.target);
  }

  args.push("--output", options.output, inputs.entry);
  return args;
}

const FORWARDED_SIGNALS: Deno.Signal[] = Deno.build.os === "windows"
  ? ["SIGINT", "SIGBREAK"]
  : ["SIGINT", "SIGTERM", "SIGHUP"];

export interface BuildChild {
  readonly status: Promise<{ success: boolean }>;
  kill(): void;
}

export type SpawnDeno = (args: readonly string[], cwd: string) => BuildChild;

const spawnDeno: SpawnDeno = (args, cwd) =>
  new Deno.Command("deno", {
    args: [...args],
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

// an interrupt stops the running child and fails every later step, so the
// restore runs after the child has exited instead of the signal killing us
export class BuildRunner {
  #interrupted = false;
  #child: BuildChild | undefined;

  constructor(private readonly spawn: SpawnDeno = spawnDeno) {}

  get interrupted(): boolean {
    return this.#interrupted;
  }

  // true when the build was already interrupted, so the caller can force-quit
  interrupt(): boolean {
    const repeated = this.#interrupted;
    this.#interrupted = true;
    try {
      this.#child?.kill();
    } catch {
      // already exited
    }
    return repeated;
  }

  async run(args: readonly string[], cwd: string): Promise<boolean> {
    if (this.#interrupted) return false;
    console.log(`Running: deno ${args.join(" ")}`);
    const child = this.spawn(args, cwd);
    this.#child = child;
    try {
      return (await child.status).success && !this.#interrupted;
    } finally {
      this.#child = undefined;
    }
  }
}

async function withInterruptGuard<T>(
  runner: BuildRunner,
  work: () => Promise<T>,
): Promise<T> {
  // a second signal force-quits, skipping the restore, if the first hangs
  const interrupt = () => {
    if (runner.interrupt()) Deno.exit(130);
  };
  for (const signal of FORWARDED_SIGNALS) {
    Deno.addSignalListener(signal, interrupt);
  }
  try {
    return await work();
  } finally {
    for (const signal of FORWARDED_SIGNALS) {
      Deno.removeSignalListener(signal, interrupt);
    }
  }
}

async function bundle(
  runner: BuildRunner,
  root: string,
): Promise<string[] | undefined> {
  const externals = requireNpmExternals(await readWorkspaceConfigs(root));
  // a leftover from an interrupted build would be embedded with the new one
  await Deno.remove(join(root, BUNDLE_DIR), { recursive: true }).catch(
    (error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    },
  );
  if (!(await runner.run(bundleArgs(BUNDLE_DIR, externals), root))) {
    return undefined;
  }
  const fileNames: string[] = [];
  const sources: string[] = [];
  for await (const entry of Deno.readDir(join(root, BUNDLE_DIR))) {
    if (!entry.isFile) continue;
    fileNames.push(entry.name);
    if (entry.name.endsWith(".map")) {
      const map = JSON.parse(
        await Deno.readTextFile(join(root, BUNDLE_DIR, entry.name)),
      ) as { sources?: string[] };
      sources.push(...(map.sources ?? []));
    }
  }
  // map sources hold resolved paths, so every base they meet must be resolved
  const realRoot = await Deno.realPath(root);
  const realBundleDir = await Deno.realPath(join(root, BUNDLE_DIR));
  const npmCache = await npmCacheDir(root);
  const realNpmCache = await Deno.realPath(npmCache).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return npmCache;
    throw error;
  });
  if (runner.interrupted) return undefined;
  requireRepoSources(sources, { bundleDir: realBundleDir, root: realRoot });
  const inlined = inlinedNpmPackages(sources, {
    bundleDir: realBundleDir,
    npmCache: realNpmCache,
  });
  if (inlined.length > 0) {
    throw new Error(
      `The bundle inlined npm packages that should stay external: ` +
        `${inlined.join(", ")}. Declare each in a workspace deno.json, ` +
        "deno.jsonc or package.json, and import it by that bare name rather " +
        'than an npm: specifier (for example "zod", not "npm:zod@4").',
    );
  }
  return sourceMapIncludes(BUNDLE_DIR, fileNames);
}

async function compile(
  runner: BuildRunner,
  options: CompileOptions,
  root: string,
): Promise<boolean> {
  if (!(await downloadDeno(runner, root, options.target))) return false;

  let entry = "main.ts";
  let extraIncludes: string[] = [];
  if (options.bundle) {
    const mapIncludes = await bundle(runner, root);
    if (mapIncludes === undefined) return false;
    entry = join(BUNDLE_DIR, "main.js");
    extraIncludes = mapIncludes;
  }

  const dashboardDistExists = await Deno.stat(
    join(root, "packages", "dashboard", "dist"),
  ).then(() => true).catch(() => false);
  return await runner.run(
    compileArgs(options, { entry, dashboardDistExists, extraIncludes }),
    root,
  );
}

if (import.meta.main) {
  if (!(await main())) {
    Deno.exit(1);
  }
}
