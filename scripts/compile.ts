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
import { isGlob, join } from "@std/path";

interface CompileOptions {
  output: string;
  target?: string;
  version?: string;
  bundle: boolean;
}

// inside the repo, so deno.json and the lockfile resolve the npm externals
// and the embedded tree keeps the repo root as its root
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

async function getGitSha(): Promise<string> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
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

async function downloadDeno(target?: string): Promise<void> {
  const downloadArgs = ["run", "-A", "scripts/download_deno.ts"];
  if (target) {
    downloadArgs.push("--target", target);
  }

  console.log(`Downloading embedded deno runtime...`);
  const command = new Deno.Command("deno", {
    args: downloadArgs,
    stdout: "inherit",
    stderr: "inherit",
  });

  const { success } = await command.output();
  if (!success) {
    throw new Error("Failed to download deno binary for embedding");
  }
}

export interface DenoConfig {
  imports?: Record<string, string>;
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
    if ("imports" in source) {
      for (const [name, target] of Object.entries(source.imports ?? {})) {
        if (target.startsWith("npm:")) names.add(name);
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

const NPM_SOURCE =
  /[\\/](?:registry\.npmjs\.org|node_modules)[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/g;

// npm files sit under the npm cache or node_modules, so a map source there
// is a package the bundle inlined instead of leaving external
export function inlinedNpmPackages(sources: readonly string[]): string[] {
  const names = new Set<string>();
  for (const source of sources) {
    let last: string | undefined;
    for (const match of source.matchAll(NPM_SOURCE)) last = match[1];
    if (last !== undefined && !last.startsWith(".")) {
      names.add(last.replace("\\", "/"));
    }
  }
  return [...names].sort();
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
    // esbuild renames colliding names; telemetry and serve read
    // error.constructor.name
    "--keep-names",
    "--sourcemap=linked",
    "--outdir",
    outDir,
    // the = form, since --external takes several values and would swallow
    // the entry
    ...externals.map((name) => `--external=${name}`),
    "main.ts",
  ];
}

// a linked map is applied only when included; the chunks themselves are
// reached through the entry's imports, so the directory is not included
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

// undefined content means nothing was stamped, so the file is left alone;
// an undefined bundleDir means no bundle was built, so the directory is too
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

  const options: CompileOptions = {
    output: args.output || "swamp",
    target: args.target,
    version: args.version,
    bundle: args.bundle,
  };

  // stamp the version only when given (CI passes --version); dev builds keep
  // the source default, so the original is saved to restore after compile
  const originalContent = await Deno.readTextFile(VERSION_FILE);
  const sha = await getGitSha();
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
  const root = join(import.meta.dirname ?? ".", "..");

  return await runStampedBuild({
    stamp: async () => {
      if (wroteStamp) {
        await Deno.writeTextFile(VERSION_FILE, stamped);
      }
    },
    build: () => compile(options, root),
    restore: () =>
      restoreBuildState(
        VERSION_FILE,
        wroteStamp ? originalContent : undefined,
        join(root, "resources", "deno"),
        options.bundle ? join(root, BUNDLE_DIR) : undefined,
      ),
  });
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

async function runDeno(args: readonly string[]): Promise<boolean> {
  console.log(`Running: deno ${args.join(" ")}`);
  const child = new Deno.Command("deno", {
    args: [...args],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  // a signal aimed at this process alone would otherwise leave the child
  // writing build output after the cleanup has run
  const stop = () => {
    try {
      child.kill();
    } catch {
      // already exited
    }
  };
  for (const signal of FORWARDED_SIGNALS) {
    Deno.addSignalListener(signal, stop);
  }
  try {
    return (await child.status).success;
  } finally {
    for (const signal of FORWARDED_SIGNALS) {
      Deno.removeSignalListener(signal, stop);
    }
  }
}

// resolves to the --include flags for the bundle's source maps, or undefined
// when the bundle failed
async function bundle(root: string): Promise<string[] | undefined> {
  const externals = requireNpmExternals(await readWorkspaceConfigs(root));
  // a leftover from an interrupted build would be embedded with the new one
  await Deno.remove(join(root, BUNDLE_DIR), { recursive: true }).catch(
    (error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    },
  );
  if (!(await runDeno(bundleArgs(BUNDLE_DIR, externals)))) return undefined;
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
  const inlined = inlinedNpmPackages(sources);
  if (inlined.length > 0) {
    throw new Error(
      `The bundle inlined npm packages that should stay external: ` +
        `${inlined.join(", ")}. Declare them in a workspace deno.json, ` +
        "deno.jsonc or package.json.",
    );
  }
  return sourceMapIncludes(BUNDLE_DIR, fileNames);
}

async function compile(
  options: CompileOptions,
  root: string,
): Promise<boolean> {
  await downloadDeno(options.target);

  let entry = "main.ts";
  let extraIncludes: string[] = [];
  if (options.bundle) {
    const mapIncludes = await bundle(root);
    if (mapIncludes === undefined) return false;
    entry = join(BUNDLE_DIR, "main.js");
    extraIncludes = mapIncludes;
  }

  const dashboardDistExists = await Deno.stat("packages/dashboard/dist")
    .then(() => true).catch(() => false);
  return await runDeno(
    compileArgs(options, { entry, dashboardDistExists, extraIncludes }),
  );
}

if (import.meta.main) {
  if (!(await main())) {
    Deno.exit(1);
  }
}
