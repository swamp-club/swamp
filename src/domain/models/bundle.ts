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

import {
  parseExtensionModule,
  type SyntaxNode,
} from "@swamp-club/extension-scoring/source";
import { getLogger } from "@logtape/logtape";
import { stripAnsiCode } from "@std/fmt/colors";
import { dirname, join, resolve, toFileUrl } from "@std/path";
import { parseRange, rangeIntersects, tryParseRange } from "@std/semver";
import * as zodModule from "zod";
import { markErrorPaths, UserError } from "../errors.ts";
import { readConfigImports } from "../extensions/dependency_resolution/import_map.ts";
import { scanImportSites } from "../extensions/dependency_resolution/import_sites.ts";
import {
  findLoaderDenoConfig,
  hasBareImport,
} from "../extensions/dependency_resolution/extension_project.ts";
import { runDenoInfo } from "../extensions/dependency_resolution/deno_info.ts";
import {
  bareImportsFromDenoInfo,
  hasUnresolvedBareImports,
  type ResolvedBareImport,
  withPackageSpecifiers,
} from "../extensions/bare_import_resolution.ts";

const logger = getLogger(["swamp", "models", "bundle"]);

const BUNDLE_TIMEOUT_MS = 120_000;

declare global {
  var __swamp_zod: typeof zodModule | undefined;
}

/**
 * bundle contract: an ES module taking zod 4 from globalThis.__swamp_zod, no
 * zod 3 import; a consumer keeps an archive's bundles only on a match, else
 * rebuilds. Unrelated to BUNDLE_LAYOUT_VERSION
 */
export const BUNDLE_FORMAT_VERSION = 1;

/**
 * shares one Zod instance with externalized extension bundles, avoiding dual
 * instances in the compiled binary where dynamic imports resolve to a separate
 * module
 */
export function installZodGlobal(): void {
  if (!globalThis.__swamp_zod) {
    globalThis.__swamp_zod = zodModule;
    logger.debug`Installed Zod global (globalThis.__swamp_zod)`;
  }
}

/**
 * processes bytes in chunks because spreading every byte as a call argument
 * overflows the call stack on large bundles
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * esbuild skips .default on CJS wrappers under --platform deno (tslib), so
 * destructuring gives undefined; always set .default, as --platform node does
 */
export function fixCjsEsmInterop(js: string): string {
  return js.replace(
    /isNodeMode \|\| !mod \|\| !mod\.__esModule \? (__defProp\(target, "default", \{ value: mod, enumerable: true \}\)) : target/,
    "$1",
  );
}

export function sanitizeDataUrlError(error: unknown): string {
  const message = String(error);
  return message.replace(
    /data:application\/javascript;base64,[A-Za-z0-9+/=]{100,}/g,
    "data:application/javascript;base64,[truncated]",
  );
}

interface ImportDeclarationSpan {
  start: number;
  end: number;
  specifier: string;
}

/**
 * parses the bundle so import text inside strings, templates, comments or
 * regexes is never reported; throws on a parse failure because guessing either
 * way silently breaks the extension
 */
function findImportDeclarations(
  js: string,
  origin?: string,
): ImportDeclarationSpan[] {
  // Read as bundle output: esbuild's syntax, recovering where Babel can.
  // Syntax errors, and stack overflow on extreme nesting, do not parse.
  const parsed = parseExtensionModule(js, { bundle: true });
  if (!parsed.ok) {
    const reason = parsed.reason;
    throw markErrorPaths(
      new UserError(
        `Cannot load the extension${origin ? ` at ${origin}` : ""}: its ` +
          `bundle holds text that looks like a zod import, and swamp could ` +
          `not parse the bundle to tell a real import from generated text ` +
          `(${reason}). A cached bundle may be damaged — delete it so swamp ` +
          `rebuilds it from the extension source, or pull the extension ` +
          `again. If the error remains, the extension uses syntax swamp's ` +
          `bundle parser does not support: report it with ` +
          `\`swamp issue bug\` and include this message.`,
        "bundle_parse_failed",
      ),
      [origin],
    );
  }

  const spans: ImportDeclarationSpan[] = [];
  const body = parsed.program.body as SyntaxNode[];
  for (const node of body) {
    if (node.type !== "ImportDeclaration") continue;
    if (typeof node.start !== "number" || typeof node.end !== "number") {
      continue;
    }
    const specifier = (node.source as SyntaxNode | undefined)?.value;
    if (typeof specifier !== "string") continue;
    spans.push({ start: node.start, end: node.end, specifier });
  }
  return spans;
}

function versionWithinMajor(version: string, major: number): boolean {
  const range = tryParseRange(version);
  if (!range) return false;
  // A prerelease of `major` (4.0.0-beta.1) counts; the next major's
  // prereleases are left out, as `<5.0.0` itself leaves them in.
  return rangeIntersects(
    range,
    parseRange(`>=${major}.0.0-0 <${major + 1}.0.0`),
  ) &&
    !rangeIntersects(range, parseRange(`<${major}.0.0-0`)) &&
    !rangeIntersects(range, parseRange(`>=${major + 1}.0.0`));
}

function zodSpecifierVersion(specifier: string): string | null | undefined {
  const match = /^(?:npm:)?zod(?:@([^/]+)(?:\/.*)?)?$/.exec(specifier);
  if (!match) return undefined;
  return match[1] ?? null;
}

/**
 * gets the host's zod 4: bare or npm zod, or any version or range admitting
 * only 4.x, at the root or /v4 subpath; push can ship any of these, rewritten
 * from an import-map target
 */
export function isZod4Specifier(specifier: string): boolean {
  const version = zodSpecifierVersion(specifier);
  if (version === undefined) return false;
  // Only the root and `/v4` are the namespace the host shares; another
  // subpath (`/v4/core`, `/mini`) has its own exports and stays bundled.
  const subpath = /^[^@]*@[^/]+(\/.*)?$/.exec(specifier)?.[1];
  if (subpath !== undefined && subpath !== "/v4") return false;
  return version === null || versionWithinMajor(version, 4);
}

export function isZod3Specifier(specifier: string): boolean {
  const version = zodSpecifierVersion(specifier);
  return typeof version === "string" && versionWithinMajor(version, 3);
}

const ZOD_VERSIONED_IMPORT_RE =
  /import\s+(?:\{[^}]+\}|\*\s+as\s+\w+)\s+from\s*["']((?:npm:)?zod@[^"']*)["']/;

/**
 * only import declarations count: zod v3 import text inside a string or
 * template literal is the extension's data
 */
export function rejectZodV3Imports(js: string, origin?: string): void {
  if (!ZOD_VERSIONED_IMPORT_RE.test(js)) return;
  for (const { start, end } of findImportDeclarations(js, origin)) {
    const match = ZOD_VERSIONED_IMPORT_RE.exec(js.slice(start, end));
    if (match && isZod3Specifier(match[1])) {
      throw new UserError(
        `Extension imports Zod v3 (${match[0].trim()}). ` +
          `Swamp requires Zod v4 — update your zod dependency to v4 and ` +
          `rebuild. See https://zod.dev/v4 for migration guidance.`,
      );
    }
  }
}

// skips obvious zod 3.x so a cached zod 3 bundle is never parsed; zod 3 is
// rejected at bundle creation by rejectZodV3Imports, not here, since this also
// runs on cached bundles at runtime
const ZOD_NAMED_IMPORT_RE =
  /import\s*\{([^}]+)\}\s*from\s*["'](?:npm:)?zod(?:@(?![\^~=v]?3)[^"']*)?["']\s*;?/g;

const ZOD_STAR_IMPORT_RE =
  /import\s*\*\s*as\s+(\w+)\s+from\s*["'](?:npm:)?zod(?:@(?![\^~=v]?3)[^"']*)?["']\s*;?/g;

function rewriteZodImportDeclaration(declaration: string): string {
  return declaration
    .replace(ZOD_NAMED_IMPORT_RE, (_match, imports: string) => {
      const destructured = imports
        .split(",")
        .map((s: string) => {
          const parts = s.trim().split(/\s+as\s+/);
          if (parts.length === 2) {
            return `${parts[0].trim()}: ${parts[1].trim()}`;
          }
          return parts[0].trim();
        })
        .filter((s: string) => s.length > 0)
        .join(", ");
      return `const { ${destructured} } = globalThis.__swamp_zod;`;
    })
    .replace(ZOD_STAR_IMPORT_RE, (_match, name: string) => {
      return `const ${name} = globalThis.__swamp_zod;`;
    });
}

/**
 * accepts isZod4Specifier plus any zod@4 spelling, subpath included, that an
 * older swamp externalized in cached bundles; new bundles never externalize
 * another subpath
 */
function isRuntimeSharedZodSpecifier(specifier: string): boolean {
  return isZod4Specifier(specifier) || /^(?:npm:)?zod@4/.test(specifier);
}

/**
 * only import declarations are rewritten; the same text in a string, template,
 * comment or regex stays byte-identical; throws when zod import text is present
 * but the bundle does not parse
 */
export function rewriteZodImports(js: string, origin?: string): string {
  // Loaders call this on every cached bundle, nearly all of them already
  // rewritten — skip the parse unless there is something that could match.
  if (
    js.search(ZOD_NAMED_IMPORT_RE) === -1 &&
    js.search(ZOD_STAR_IMPORT_RE) === -1
  ) {
    return js;
  }

  const parts: string[] = [];
  let cursor = 0;
  for (
    const { start, end, specifier } of findImportDeclarations(js, origin)
  ) {
    if (!isRuntimeSharedZodSpecifier(specifier)) continue;
    parts.push(js.slice(cursor, start));
    parts.push(rewriteZodImportDeclaration(js.slice(start, end)));
    cursor = end;
  }
  if (cursor === 0) return js;
  parts.push(js.slice(cursor));
  return parts.join("");
}

/**
 * readOnlyLock never writes the lockfile (--frozen if present, else --no-lock)
 * and reads node_modules as installed; noConfig stops a stray working-directory
 * deno.json applying; a project config wins
 */
export function denoProjectArgs(
  options?: {
    denoConfigPath?: string;
    packageJsonDir?: string;
    readOnlyLock?: ReadOnlyLock;
    noConfig?: boolean;
  },
): string[] {
  const noConfig = options?.noConfig ? ["--no-config"] : [];
  const project = options?.denoConfigPath
    ? ["--config", options.denoConfigPath]
    : options?.packageJsonDir
    ? [...noConfig, "--node-modules-dir=auto"]
    : undefined;
  if (!project) {
    return [...noConfig, "--no-lock", "--node-modules-dir=none"];
  }
  if (!options?.readOnlyLock) return project;
  return [
    ...(options.denoConfigPath
      ? project
      : [...noConfig, "--node-modules-dir=manual"]),
    options.readOnlyLock.lockPath ? "--frozen" : "--no-lock",
  ];
}

export interface ReadOnlyLock {
  lockPath?: string;
}

export function isStaleLockfile(output: string): boolean {
  return stripAnsiCode(output).includes("The lockfile is out of date");
}

/** extension fmt reads these to warn instead of failing */
export class StaleLockfileError extends UserError {
  constructor(
    message: string,
    readonly lockPath: string,
    readonly projectFile: string,
    readonly projectDir: string,
    readonly entryPoint: string,
  ) {
    super(message);
    this.name = "StaleLockfileError";
  }
}

export interface StaleLockfile {
  lockPath: string;
  projectFile: string;
  projectDir: string;
  entryPoints: string[];
}

export function groupStaleLockfiles(
  errors: readonly StaleLockfileError[],
): StaleLockfile[] {
  const byLock = new Map<string, StaleLockfile>();
  for (const error of errors) {
    const lock = byLock.get(error.lockPath) ?? {
      lockPath: error.lockPath,
      projectFile: error.projectFile,
      projectDir: error.projectDir,
      entryPoints: [],
    };
    if (!lock.entryPoints.includes(error.entryPoint)) {
      lock.entryPoints.push(error.entryPoint);
    }
    byLock.set(error.lockPath, lock);
  }
  return [...byLock.values()];
}

/** a path with whitespace is double-quoted, which every shell reads alike */
export function staleLockfileInstallCommand(lock: StaleLockfile): string {
  const quoted = lock.entryPoints.map((p) => /\s/.test(p) ? `"${p}"` : p);
  return `deno install --entrypoint ${quoted.join(" ")}`;
}

/**
 * push treats the author's lock as read-only, so a stale lock errors naming the
 * command that updates it, keeping deno's change list but not its
 * --frozen=false hint
 */
export function staleLockfileError(
  lockPath: string,
  entryPoint: string,
  project: {
    denoConfigPath?: string;
    packageJsonDir?: string;
    workspaceRootConfigPath?: string;
  },
  output: string,
): StaleLockfileError {
  // A workspace member's lock is the root's, brought up to date there.
  const configPath = project.workspaceRootConfigPath ?? project.denoConfigPath;
  const projectFile = configPath ?? "package.json";
  const projectDir = configPath
    ? dirname(configPath)
    : project.packageJsonDir ?? dirname(lockPath);
  const plain = stripAnsiCode(output);
  const changesAt = plain.indexOf("changes:");
  const changes = changesAt >= 0 ? `\n${plain.slice(changesAt).trimEnd()}` : "";
  return markErrorPaths(
    new StaleLockfileError(
      `${lockPath} is out of date with ${projectFile}, and push and quality ` +
        `never rewrite your lockfile. Run \`deno install --entrypoint ` +
        `${entryPoint}\` in ${projectDir}, commit the updated lock, and try ` +
        `again.${changes}`,
      lockPath,
      projectFile,
      projectDir,
      entryPoint,
    ),
    [lockPath, projectFile, entryPoint, projectDir],
  );
}

export interface BundleOptions {
  /**
   * inlines all dependencies including zod, for out-of-process execution such
   * as Docker containers
   */
  selfContained?: boolean;

  denoConfigPath?: string;

  /** mutually exclusive with denoConfigPath */
  packageJsonDir?: string;

  /**
   * bundles with --frozen when a lock exists, so a stale lock fails with
   * staleLockfileError, else --no-lock; push, quality and the extension loader
   * set this
   */
  readOnlyLock?: ReadOnlyLock;

  /**
   * set for rebuilds of pulled extension source so a consumer repo's deno.json
   * never resolves its imports, and by push without a Deno config in the repo;
   * ignored with denoConfigPath
   */
  noConfig?: boolean;

  /**
   * the workspace root that denoConfigPath is a member of, whose lock the
   * bundle reads; named by a stale-lock error
   */
  workspaceRootConfigPath?: string;

  /**
   * use to set DENO_DIR so the subprocess cache avoids the home Library cache,
   * which triggers macOS TCC prompts
   */
  env?: Record<string, string>;

  signal?: AbortSignal;

  /**
   * without it the bundler reads the module graph itself to decide whether a
   * bare zod is the host's zod 4
   */
  bareImports?: readonly ResolvedBareImport[];
}

/**
 * expected failure: a pulled extension with bare specifiers but no project
 * config, so the cached bundle is used silently; false when a deno.json exists
 * or there are no bare specifiers
 */
export function isExpectedBundleFailure(
  absolutePath: string,
  repoDir?: string,
): boolean {
  // A config above the source should have resolved its specifiers, so a
  // failure under one is unexpected.
  if (findLoaderDenoConfig(absolutePath, repoDir)) return false;

  try {
    return hasBareImport(Deno.readTextFileSync(absolutePath), absolutePath);
  } catch {
    return false; // Can't read source — treat as unexpected
  }
}

const MAX_ZOD_SCAN_MODULES = 2000;

/**
 * exact spellings so deno bundle --external matches each, no deno call;
 * unreadable or unparsable modules are skipped for the bundler to report; past
 * the scan cap a zod import is inlined
 */
export async function zod4SpecifiersReachedFrom(
  entry: string,
): Promise<string[]> {
  const found = new Set<string>();
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0 && seen.size <= MAX_ZOD_SCAN_MODULES) {
    const path = queue.shift()!;
    let source: string;
    try {
      source = await Deno.readTextFile(path);
    } catch {
      continue;
    }
    for (const { specifier: spec } of scanImportSites(source, path) ?? []) {
      if (spec.startsWith("npm:zod") && isZod4Specifier(spec)) {
        found.add(spec);
      } else if (spec.startsWith("./") || spec.startsWith("../")) {
        const target = resolve(dirname(path), spec);
        if (!seen.has(target) && /\.[cm]?[jt]sx?$/.test(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
  }
  return [...found].sort();
}

/**
 * none when any module resolves bare zod elsewhere or to nothing, so the bundle
 * inlines it
 */
export function sharedZodTargets(
  resolutions: readonly ResolvedBareImport[],
): string[] {
  const targets = new Set<string>();
  for (const r of resolutions) {
    if (r.specifier !== "zod") continue;
    const target = r.target?.replace(/^npm:\//, "npm:");
    if (
      !target || !target.startsWith("npm:zod@") || !isZod4Specifier(target) ||
      /^npm:zod@[^/]+\//.test(target)
    ) {
      return [];
    }
    targets.add(target);
  }
  return [...targets].sort();
}

/** only a fallback for externalizing zod when Deno gave no answer for it */
async function configZodTarget(
  denoConfigPath: string,
): Promise<string | undefined> {
  const target = (await readConfigImports(denoConfigPath))?.["zod"];
  return typeof target === "string" && target.startsWith("npm:zod@") &&
      isZod4Specifier(target) && !/^npm:zod@[^/]+\//.test(target)
    ? target
    : undefined;
}

/**
 * below a node_modules deno info names a root by real path, so an entry reached
 * through a symlink (macOS /var) would be read in two spellings; such an entry
 * is read by its real path
 */
export async function denoInfoEntryPoint(entryPoint: string): Promise<string> {
  const real = await Deno.realPath(entryPoint).catch(() => entryPoint);
  return real !== entryPoint && real.split(/[\\/]/).includes("node_modules")
    ? real
    : entryPoint;
}

/**
 * read under --no-lock so a resolution query never writes the author's lock;
 * undefined when the graph read fails, which callers treat as no answer for any
 * name
 */
async function readBareImports(
  entryPoint: string,
  denoPath: string,
  options: BundleOptions,
): Promise<ResolvedBareImport[] | undefined> {
  const root = toFileUrl(await denoInfoEntryPoint(entryPoint)).href;
  const read = async (extraArgs: string[]) => {
    const result = await runDenoInfo(denoPath, root, entryPoint, {
      // A resolution query only: never write or freeze the author's lock.
      args: [
        ...denoProjectArgs({ ...options, readOnlyLock: {} }),
        ...extraArgs,
      ],
      signal: options.signal ?? AbortSignal.timeout(BUNDLE_TIMEOUT_MS),
      ...(options.env ? { env: options.env } : {}),
    });
    return result.success
      ? bareImportsFromDenoInfo(result.graph.json)
      : undefined;
  };
  try {
    const first = await read([]);
    if (!first) {
      logger.debug`deno info failed for ${entryPoint}`;
      return undefined;
    }
    if (!hasUnresolvedBareImports(first)) return first;
    return withPackageSpecifiers(
      first,
      await read(["--node-modules-dir=none"]).catch(() => undefined) ?? [],
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    logger.debug`Could not read the module graph of ${entryPoint}: ${error}`;
    return undefined;
  }
}

async function isZod4InPackageJson(
  packageJsonDir: string,
): Promise<boolean> {
  try {
    const raw = await Deno.readTextFile(join(packageJsonDir, "package.json"));
    const pkg = JSON.parse(raw);
    const deps: Record<string, string> = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    const zodVersion = deps["zod"];
    if (!zodVersion) return false;
    return /^[\^~>=]*4(?:\.|$)/.test(zodVersion);
  } catch {
    return false;
  }
}

/**
 * two bundles started at once on a cache without esbuild both install it, and
 * one can fail copying the binary the other is writing
 */
export function isEsbuildInstallRace(output: string): boolean {
  return output.includes("failed to copy esbuild binary");
}

/**
 * the first call runs alone and later calls wait, then run side by side; a
 * first call that throws or fails succeeded() clears the key so the next caller
 * goes first
 */
export async function runFirstAlone<T>(
  gates: Map<string, Promise<boolean>>,
  key: string,
  fn: () => Promise<T>,
  options: { signal?: AbortSignal; succeeded?: (result: T) => boolean } = {},
): Promise<T> {
  for (let gate = gates.get(key); gate; gate = gates.get(key)) {
    if (await abortable(gate, options.signal)) return await fn();
  }
  let settle!: (ok: boolean) => void;
  gates.set(key, new Promise<boolean>((resolve) => settle = resolve));
  let ok = false;
  try {
    const result = await fn();
    ok = options.succeeded?.(result) ?? true;
    return result;
  } finally {
    if (!ok) gates.delete(key);
    settle(ok);
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", onAbort)
    );
  });
}

/**
 * The first bundle per Deno cache in this process, which installs esbuild
 * into an empty cache and so must not race another bundle doing the same.
 */
const firstBundles = new Map<string, Promise<boolean>>();

/**
 * only zod is externalized so extensions share swamp's zod instance (needed for
 * schema instanceof checks); the rest is inlined to work in the compiled binary
 * with only swamp's embedded graph
 */
export async function bundleExtension(
  absolutePath: string,
  denoPath: string,
  options?: BundleOptions,
): Promise<string> {
  logger.debug`Bundling extension: ${absolutePath}`;

  const tempFile = await Deno.makeTempFile({
    prefix: "swamp_bundle_",
    suffix: ".js",
  });

  try {
    // deno.json: --config so the import map governs; package.json: deno finds
    // it via cwd, local loading uses --node-modules-dir=auto, push and quality
    // read the installed tree as is; else --no-lock
    const args = ["bundle", ...denoProjectArgs(options)];

    // externalize zod so in-process extensions share the host's zod instance
    // (needed for instanceof schema checks); self-contained bundles inline
    // everything for out-of-process use
    if (!options?.selfContained) {
      args.push("--external", "npm:zod@4", "--external", "npm:zod");

      // other zod 4 spellings (pinned or ranged, as push ships an import-map
      // target in place of bare zod) match only as written, so externalize each
      // one the entry point's modules write
      for (const spec of await zod4SpecifiersReachedFrom(absolutePath)) {
        args.push("--external", spec);
      }

      // bare zod is externalized, with each target, only when every module
      // resolves it to zod 4; externalizing a zod 3 import would silently break
      // since globalThis.__swamp_zod is zod 4
      if (options?.denoConfigPath) {
        const resolutions = options.bareImports ??
          await readBareImports(absolutePath, denoPath, options);
        let targets = sharedZodTargets(resolutions ?? []);
        // when Deno gives no answer (graph read failed or offline registry
        // error) keep the config's own zod 4 entry external rather than inline
        // a second zod that fails instanceof; only externals follow this
        if (
          targets.length === 0 &&
          (resolutions === undefined ||
            resolutions.some((r) => r.specifier === "zod" && !r.target))
        ) {
          const fallback = await configZodTarget(options.denoConfigPath);
          if (fallback) targets = [fallback];
        }
        for (const target of targets) args.push("--external", target);
        if (targets.length > 0) args.push("--external", "zod");
      }

      // bare zod is externalized only when package.json lists zod 4.x
      if (options?.packageJsonDir) {
        const isZod4 = await isZod4InPackageJson(options.packageJsonDir);
        if (isZod4) {
          args.push("--external", "zod");
        }
      }
    }

    args.push("--platform", "deno", "-o", tempFile, absolutePath);

    // Each run gets its own timeout, started when it runs: never spent
    // waiting behind the first bundle.
    const runBundle = () =>
      new Deno.Command(denoPath, {
        args,
        stdout: "piped",
        stderr: "piped",
        signal: options?.signal ?? AbortSignal.timeout(BUNDLE_TIMEOUT_MS),
        ...(options?.packageJsonDir ? { cwd: options.packageJsonDir } : {}),
        ...(options?.env ? { env: options.env } : {}),
      }).output();

    // A bundle that lost an esbuild install race to another process is
    // retried once, inside the gate: a waiter must not start beside it.
    const runWithRetry = async () => {
      const first = await runBundle();
      if (first.success || !isEsbuildInstallRace(outputText(first))) {
        return first;
      }
      logger
        .debug`Retrying bundle of ${absolutePath} after an esbuild install race`;
      return await runBundle();
    };

    // The child's cache: options.env merges over this process's env.
    const denoDir = options?.env?.DENO_DIR ?? Deno.env.get("DENO_DIR") ??
      "";
    const output = await runFirstAlone(firstBundles, denoDir, runWithRetry, {
      signal: options?.signal,
      // Still lost after the retry: the cache may lack esbuild, so the next
      // bundle installs it alone again.
      succeeded: (result) =>
        result.success || !isEsbuildInstallRace(outputText(result)),
    });

    if (!output.success) {
      const lockPath = options?.readOnlyLock?.lockPath;
      if (lockPath && isStaleLockfile(outputText(output))) {
        throw staleLockfileError(
          lockPath,
          absolutePath,
          options,
          outputText(output),
        );
      }
      const rawDetails = outputText(output).trim() ||
        "(no output — try running deno 2.7.x or later)";
      const details = stripAnsiCode(rawDetails);
      throw markErrorPaths(
        new Error(
          `deno bundle failed for ${absolutePath}: ${details}`,
        ),
        [absolutePath],
      );
    }

    let js = await Deno.readTextFile(tempFile);

    if (!js) {
      // type-only files bundle to nothing, so return a minimal module the
      // loader can skip
      js = "export {};\n";
    }

    js = fixCjsEsmInterop(js);

    if (!options?.selfContained) {
      rejectZodV3Imports(js, absolutePath);
      js = rewriteZodImports(js, absolutePath);
    }

    logger.debug`Bundled ${absolutePath} (${js.length} bytes)`;
    return js;
  } finally {
    try {
      await Deno.remove(tempFile);
    } catch {
      // Temp file cleanup is best-effort
    }
  }
}

function outputText(output: Deno.CommandOutput): string {
  const decoder = new TextDecoder();
  return decoder.decode(output.stderr) + decoder.decode(output.stdout);
}
