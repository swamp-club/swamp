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

import { parse as parseYaml } from "@std/yaml";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { markErrorPaths, UserError } from "../domain/errors.ts";
import {
  validateWebhookEntry,
  type WebhookConfigEntry,
} from "./serve_config.ts";
import { type WebhookEndpoint, WebhookEnvironmentError } from "./webhook.ts";
import { fileRouteProblem } from "./webhook_route.ts";

const ROUTE_FILE_KEYS: ReadonlySet<string> = new Set([
  "route",
  "workflow",
  "secret",
  "scheme",
  "header",
  "prefix",
  "config",
]);

const ROUTE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([".yaml", ".yml"]);

const VAULT_SECRET_PREFIX = "@vault=";

// one route is a few lines; the cap keeps a stray large file out of the parser
const MAX_ROUTE_FILE_BYTES = 64 * 1024;

const MAX_ROUTE_FILE_DEPTH = 32;

/**
 * a YAML alias parses to a shared node or a repeated string, so a few hundred
 * bytes can expand to gigabytes when serve compares or validates the route
 */
const ALIAS_TEXT_PROBLEM =
  "its values hold more text than the file itself, which only YAML aliases " +
  "produce; route files do not allow them";

function yamlShapeProblem(value: unknown): string | undefined {
  const seen = new Set<object>();
  let text = 0;
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (typeof node === "string") text += node.length;
    if (text > MAX_ROUTE_FILE_BYTES) return ALIAS_TEXT_PROBLEM;
    if (typeof node !== "object" || node === null) continue;
    if (seen.has(node)) {
      return "it uses YAML anchors and aliases, which route files do not allow";
    }
    seen.add(node);
    if (depth >= MAX_ROUTE_FILE_DEPTH) {
      return `it nests deeper than ${MAX_ROUTE_FILE_DEPTH} levels`;
    }
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(node)) {
      text += key.length;
      stack.push({ node: child, depth: depth + 1 });
    }
  }
  return text > MAX_ROUTE_FILE_BYTES ? ALIAS_TEXT_PROBLEM : undefined;
}

export interface WebhookRouteFile {
  readonly file: string;
  readonly entry: WebhookConfigEntry;
}

export interface RefusedRouteFile {
  readonly file: string;
  readonly route?: string;
  readonly message: string;
  /** the environment failed rather than the file, so a later try may load it */
  readonly outage?: boolean;
}

export interface RouteFileLoad {
  readonly files: readonly WebhookRouteFile[];
  readonly refused: readonly RefusedRouteFile[];
}

/**
 * a route file that failed to load but still serves: through an outage while
 * unchanged, or as its last good route after a refused edit
 */
export interface KeptRouteFile {
  readonly file: string;
  readonly route: string;
  readonly reason: "outage" | "last_good";
  readonly message: string;
}

export interface ShadowedRouteFile {
  readonly file: string;
  readonly route: string;
  readonly by: "config" | "flag";
}

function label(file: string, route?: string): string {
  return route === undefined
    ? `webhook route file ${file}`
    : `webhook route file ${file} (route ${route})`;
}

function refusal(
  file: string,
  route: string | undefined,
  reason: string,
): RefusedRouteFile {
  const where = label(file, route);
  return {
    file,
    ...(route !== undefined ? { route } : {}),
    message: `Refused ${where}: ${reason}`,
  };
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${SEPARATOR}`) &&
    !isAbsolute(rel);
}

// a missing path takes its nearest existing ancestor's real spelling, so it
// compares equal to real paths through the same symlinks (macOS /var)
async function realOrResolved(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return join(await Deno.realPath(current), ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** a security rule, so file routes are dropped rather than kept */
export class WebhookRoutesDirPlacementError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = "WebhookRoutesDirPlacementError";
  }
}

/**
 * refuses a routes directory that is, or sits inside, a directory holding
 * extension code, so the option can never point the loader at an extension
 */
export async function checkWebhookRoutesDir(
  dir: string,
  extensionDirs: readonly string[],
): Promise<void> {
  const routes = await realOrResolved(dir);
  for (const extensionDir of extensionDirs) {
    const forbidden = await realOrResolved(extensionDir);
    if (routes === forbidden || isInside(forbidden, routes)) {
      throw markErrorPaths(
        new WebhookRoutesDirPlacementError(
          `Webhook routes directory ${dir} is or sits inside ` +
            `${extensionDir}, which holds extension code; route files must ` +
            "live in their own directory (set --webhook-routes-dir, " +
            "webhook-routes-dir in the serve config, or " +
            "SWAMP_WEBHOOK_ROUTES_DIR)",
        ),
        [dir, extensionDir],
      );
    }
  }
}

async function readRouteFile(
  dir: string,
  realDir: string,
  file: string,
  isSymlink: boolean,
): Promise<WebhookRouteFile | RefusedRouteFile> {
  const path = join(dir, file);
  if (isSymlink) {
    let target: string;
    try {
      target = await Deno.realPath(path);
    } catch (cause) {
      return refusal(
        file,
        undefined,
        `its symlink cannot be followed: ${cause}`,
      );
    }
    if (!isInside(realDir, target)) {
      return refusal(
        file,
        undefined,
        "it is a symlink to a file outside the routes directory",
      );
    }
  }

  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch (cause) {
    return refusal(file, undefined, `it cannot be read: ${cause}`);
  }
  if (!info.isFile) {
    return refusal(file, undefined, "it is not a regular file");
  }
  if (info.size > MAX_ROUTE_FILE_BYTES) {
    return refusal(
      file,
      undefined,
      `it is ${info.size} bytes; a route file may hold at most ` +
        `${MAX_ROUTE_FILE_BYTES}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(await Deno.readTextFile(path));
  } catch (cause) {
    return refusal(file, undefined, `it is not readable YAML: ${cause}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refusal(
      file,
      undefined,
      "it must hold one YAML mapping (one route)",
    );
  }
  const shapeProblem = yamlShapeProblem(parsed);
  if (shapeProblem !== undefined) {
    return refusal(file, undefined, shapeProblem);
  }
  const obj = parsed as Record<string, unknown>;
  const route = typeof obj.route === "string" ? obj.route : undefined;

  const unknown = Object.keys(obj).filter((key) => !ROUTE_FILE_KEYS.has(key));
  if (unknown.length > 0) {
    return refusal(
      file,
      route,
      `unknown key${unknown.length > 1 ? "s" : ""} ${
        unknown.map((key) => `'${key}'`).join(", ")
      }; a route file takes ${[...ROUTE_FILE_KEYS].join(", ")}`,
    );
  }

  try {
    validateWebhookEntry(obj, path, label(file));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = `Invalid ${label(file)}: `;
    return refusal(
      file,
      route,
      message.startsWith(prefix) ? message.slice(prefix.length) : message,
    );
  }
  const entry = obj as unknown as WebhookConfigEntry;

  // a literal secret would live in git; env and file refs name host state a
  // repo change should not reach
  if (!entry.secret.startsWith(VAULT_SECRET_PREFIX)) {
    return refusal(
      file,
      entry.route,
      `the secret must be a vault reference (${VAULT_SECRET_PREFIX}<vault>:<key>); ` +
        "route files refuse literal, @env= and @file= secrets",
    );
  }

  const problem = fileRouteProblem(entry.route);
  if (problem !== undefined) {
    return refusal(file, entry.route, `the route ${problem}`);
  }

  return { file, entry };
}

/** the loader and the poll snapshot must agree on which files count */
function isRouteFileCandidate(item: Deno.DirEntry): boolean {
  return !item.name.startsWith(".") && !item.isDirectory &&
    ROUTE_FILE_EXTENSIONS.has(extname(item.name).toLowerCase());
}

async function digestHex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** a file swapped or grown after its stat is still read within the cap */
async function readAtMost(
  path: string,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  using file = await Deno.open(path, { read: true });
  if (!(await file.stat()).isFile) return new Uint8Array(0);
  const buffer = new Uint8Array(limit);
  let filled = 0;
  while (filled < limit) {
    const read = await file.read(buffer.subarray(filled));
    if (read === null) break;
    filled += read;
  }
  return buffer.slice(0, filled);
}

/**
 * a value that changes whenever a file the loader would read changes; files
 * over the size cap count by size alone, since the loader refuses them unread
 */
export async function snapshotWebhookRoutesDir(dir: string): Promise<string> {
  let realDir: string;
  const items: { name: string; isSymlink: boolean }[] = [];
  try {
    realDir = await Deno.realPath(dir);
    for await (const item of Deno.readDir(dir)) {
      if (isRouteFileCandidate(item)) {
        items.push({ name: item.name, isSymlink: item.isSymlink });
      }
    }
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return "missing";
    throw cause;
  }
  items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const entries: string[] = [];
  for (const { name, isSymlink } of items) {
    const path = join(dir, name);
    try {
      // like the loader, never read through a symlink that leaves the directory
      if (isSymlink) {
        const target = await Deno.realPath(path);
        if (!isInside(realDir, target)) {
          entries.push(`${name}:outside:${target}`);
          continue;
        }
      }
      const info = await Deno.stat(path);
      if (!info.isFile || info.size > MAX_ROUTE_FILE_BYTES) {
        entries.push(`${name}:${info.isFile ? "file" : "other"}:${info.size}`);
        continue;
      }
      const bytes = await readAtMost(path, MAX_ROUTE_FILE_BYTES + 1);
      entries.push(`${name}:${bytes.length}:${await digestHex(bytes)}`);
    } catch (cause) {
      entries.push(`${name}:unreadable:${cause}`);
    }
  }
  return JSON.stringify([realDir, entries]);
}

/** a bad file is refused alone; only an unreadable directory throws */
export async function loadWebhookRouteFiles(
  dir: string,
): Promise<RouteFileLoad> {
  const names: { name: string; isSymlink: boolean }[] = [];
  try {
    for await (const item of Deno.readDir(dir)) {
      if (!isRouteFileCandidate(item)) continue;
      names.push({ name: item.name, isSymlink: item.isSymlink });
    }
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) {
      return { files: [], refused: [] };
    }
    throw markErrorPaths(
      new UserError(`Failed to read webhook routes directory ${dir}: ${cause}`),
      [dir],
    );
  }
  names.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  const realDir = names.some((n) => n.isSymlink)
    ? await Deno.realPath(dir)
    : dir;
  const loaded: WebhookRouteFile[] = [];
  const refused: RefusedRouteFile[] = [];
  for (const { name, isSymlink } of names) {
    const result = await readRouteFile(dir, realDir, name, isSymlink);
    if ("entry" in result) loaded.push(result);
    else refused.push(result);
  }

  const byRoute = new Map<string, WebhookRouteFile[]>();
  for (const routeFile of loaded) {
    const claims = byRoute.get(routeFile.entry.route) ?? [];
    claims.push(routeFile);
    byRoute.set(routeFile.entry.route, claims);
  }
  const files: WebhookRouteFile[] = [];
  for (const routeFile of loaded) {
    const claims = byRoute.get(routeFile.entry.route)!;
    if (claims.length === 1) {
      files.push(routeFile);
      continue;
    }
    const others = claims.filter((c) => c !== routeFile).map((c) => c.file);
    refused.push(
      refusal(
        routeFile.file,
        routeFile.entry.route,
        `${others.join(", ")} also claim${
          others.length > 1 ? "" : "s"
        } this route; each route belongs to one file`,
      ),
    );
  }
  return { files, refused };
}

// YAML yields Date and Uint8Array beside plain data; key order never counts.
// Route files are bounded in size and depth by the loader, so recursion is safe
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date &&
      Object.is(a.getTime(), b.getTime());
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array &&
      a.length === b.length && a.every((byte, i) => byte === b[i]);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((item, i) => sameValue(item, b[i]));
  }
  if (
    typeof a !== "object" || a === null || typeof b !== "object" || b === null
  ) {
    return Object.is(a, b);
  }
  const aKeys = Object.keys(a);
  const bRecord = b as Record<string, unknown>;
  return aKeys.length === Object.keys(b).length &&
    aKeys.every((key) =>
      Object.hasOwn(bRecord, key) &&
      sameValue((a as Record<string, unknown>)[key], bRecord[key])
    );
}

/**
 * a missing vault key or an unresolvable scheme refuses only that file; an
 * outage keeps the file's live endpoint, but only while the file is unchanged
 */
export async function parseRouteFiles(
  files: readonly WebhookRouteFile[],
  parse: (configs: readonly WebhookConfigEntry[]) => Promise<WebhookEndpoint[]>,
  previous: readonly WebhookEndpoint[] = [],
): Promise<{
  endpoints: WebhookEndpoint[];
  refused: RefusedRouteFile[];
  kept: KeptRouteFile[];
}> {
  const endpoints: WebhookEndpoint[] = [];
  const refused: RefusedRouteFile[] = [];
  const kept: KeptRouteFile[] = [];
  for (const { file, entry } of files) {
    try {
      const [endpoint] = await parse([entry]);
      endpoints.push({
        ...endpoint,
        source: "file",
        file,
        routeFileEntry: entry,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const live = error instanceof WebhookEnvironmentError
        ? previous.find((e) =>
          e.source === "file" && e.file === file && e.route === entry.route &&
          e.routeFileEntry !== undefined && sameValue(e.routeFileEntry, entry)
        )
        : undefined;
      if (live) {
        endpoints.push(live);
        kept.push({
          file,
          route: entry.route,
          reason: "outage",
          message: `Kept the live endpoint for ${
            label(file, entry.route)
          }, unchanged since it last loaded: ${reason}`,
        });
        continue;
      }
      refused.push({
        ...refusal(file, entry.route, reason),
        ...(error instanceof WebhookEnvironmentError ? { outage: true } : {}),
      });
    }
  }
  return { endpoints, refused, kept };
}

export interface LastGoodRouteFilesInput {
  readonly previous: readonly WebhookEndpoint[];
  /** the files the loader read, so a parse refusal can tell an edit apart */
  readonly files: readonly WebhookRouteFile[];
  readonly parsed: {
    readonly endpoints: readonly WebhookEndpoint[];
    readonly refused: readonly RefusedRouteFile[];
    readonly kept: readonly KeptRouteFile[];
  };
  readonly loaderRefused: readonly RefusedRouteFile[];
  /** the routes directory could not be read; never set for a placement refusal */
  readonly directoryUnreadable: boolean;
  /** re-checks a last good entry, so a revoked key or scheme is not kept */
  readonly parse: (
    configs: readonly WebhookConfigEntry[],
  ) => Promise<WebhookEndpoint[]>;
  /** why a kept endpoint may no longer serve, e.g. an untrusted scheme */
  readonly keepRefusal?: (endpoint: WebhookEndpoint) => string | undefined;
}

interface KeepCandidate {
  readonly endpoint: WebhookEndpoint;
  readonly kept: KeptRouteFile;
  readonly refusal: RefusedRouteFile;
}

function lastGoodEndpoint(
  previous: readonly WebhookEndpoint[],
  file: string,
): WebhookEndpoint | undefined {
  return previous.find((e) => e.source === "file" && e.file === file);
}

function lastGoodCandidate(
  endpoint: WebhookEndpoint,
  refused: RefusedRouteFile,
): KeepCandidate {
  return {
    endpoint,
    refusal: refused,
    kept: {
      file: refused.file,
      route: endpoint.route,
      reason: "last_good",
      message: `${refused.message}; its last good route ${endpoint.route} ` +
        "keeps serving until the file loads",
    },
  };
}

function notKept(candidate: KeepCandidate, why: string): RefusedRouteFile {
  return {
    ...candidate.refusal,
    message: `${candidate.refusal.message}; its last good route ` +
      `${candidate.endpoint.route} was not kept: ${why}`,
  };
}

/**
 * Re-parses the last good entry: a fresh secret on success, the old endpoint
 * through an outage, and no endpoint when the vault or trust list now says no.
 */
async function recheckLastGood(
  candidate: KeepCandidate,
  parse: LastGoodRouteFilesInput["parse"],
): Promise<{ endpoint: WebhookEndpoint } | { refusal: string }> {
  const entry = candidate.endpoint.routeFileEntry;
  if (entry === undefined) return { endpoint: candidate.endpoint };
  try {
    const [fresh] = await parse([entry]);
    return {
      endpoint: {
        ...fresh,
        source: "file",
        file: candidate.endpoint.file,
        routeFileEntry: entry,
      },
    };
  } catch (error) {
    if (error instanceof WebhookEnvironmentError) {
      return { endpoint: candidate.endpoint };
    }
    return { refusal: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A file that loaded before keeps its last good route when an edit or a broken
 * directory stops it loading; an answer that revokes the route still drops it.
 */
export async function keepLastGoodRouteFiles(
  input: LastGoodRouteFilesInput,
): Promise<{
  endpoints: WebhookEndpoint[];
  refused: RefusedRouteFile[];
  kept: KeptRouteFile[];
}> {
  const { previous, parsed } = input;
  const candidates: KeepCandidate[] = [];
  const refused: RefusedRouteFile[] = [];

  if (input.directoryUnreadable) {
    for (const endpoint of previous) {
      if (endpoint.source !== "file" || endpoint.file === undefined) continue;
      const reason = "the routes directory could not be read";
      candidates.push({
        endpoint,
        refusal: refusal(endpoint.file, endpoint.route, reason),
        kept: {
          file: endpoint.file,
          route: endpoint.route,
          reason: "outage",
          message: `Kept the live endpoint for ${
            label(endpoint.file, endpoint.route)
          }: ${reason}`,
        },
      });
    }
  }
  for (const loaderRefusal of input.loaderRefused) {
    const live = lastGoodEndpoint(previous, loaderRefusal.file);
    if (live) candidates.push(lastGoodCandidate(live, loaderRefusal));
    else refused.push(loaderRefusal);
  }
  for (const parseRefusal of parsed.refused) {
    const live = lastGoodEndpoint(previous, parseRefusal.file);
    const entry = input.files.find((f) => f.file === parseRefusal.file)?.entry;
    const edited = live !== undefined && entry !== undefined &&
      (live.routeFileEntry === undefined ||
        !sameValue(live.routeFileEntry, entry));
    if (live && edited) candidates.push(lastGoodCandidate(live, parseRefusal));
    else refused.push(parseRefusal);
  }

  const outageKept = new Set(parsed.kept.map((k) => k.file));
  const endpoints: WebhookEndpoint[] = [];
  const kept: KeptRouteFile[] = [];
  for (const endpoint of parsed.endpoints) {
    const keptEntry = outageKept.has(endpoint.file ?? "")
      ? parsed.kept.find((k) => k.file === endpoint.file)
      : undefined;
    const stale = keptEntry ? input.keepRefusal?.(endpoint) : undefined;
    if (keptEntry && stale !== undefined) {
      refused.push(refusal(keptEntry.file, keptEntry.route, stale));
      continue;
    }
    endpoints.push(endpoint);
    if (keptEntry) kept.push(keptEntry);
  }

  const claimed = new Map(endpoints.map((e) => [e.route, e.file ?? ""]));
  for (const candidate of candidates) {
    // a file that loads beats a kept route on the same path
    const claimer = claimed.get(candidate.endpoint.route);
    if (claimer !== undefined) {
      refused.push(notKept(candidate, `${claimer} now serves it`));
      continue;
    }
    const stale = input.keepRefusal?.(candidate.endpoint);
    if (stale !== undefined) {
      refused.push(notKept(candidate, stale));
      continue;
    }
    const checked = await recheckLastGood(candidate, input.parse);
    if ("refusal" in checked) {
      refused.push(notKept(candidate, checked.refusal));
      continue;
    }
    claimed.set(checked.endpoint.route, checked.endpoint.file ?? "");
    endpoints.push(checked.endpoint);
    kept.push(candidate.kept);
  }
  return { endpoints, refused, kept };
}

type RouteOrigin = Pick<WebhookEndpoint, "route" | "source" | "file">;

export function mergeWebhookRoutes<T extends RouteOrigin>(
  operator: readonly T[],
  files: readonly T[],
): { endpoints: T[]; shadowed: ShadowedRouteFile[] } {
  const operatorByRoute = new Map(operator.map((e) => [e.route, e]));
  const endpoints = [...operator];
  const shadowed: ShadowedRouteFile[] = [];
  for (const endpoint of files) {
    const winner = operatorByRoute.get(endpoint.route);
    if (winner === undefined) {
      endpoints.push(endpoint);
      continue;
    }
    shadowed.push({
      file: endpoint.file ?? "",
      route: endpoint.route,
      by: winner.source === "flag" ? "flag" : "config",
    });
  }
  return { endpoints, shadowed };
}

export function shadowedRouteFileMessage(shadow: ShadowedRouteFile): string {
  const winner = shadow.by === "flag" ? "a --webhook flag" : "the serve config";
  return `Shadowed ${label(shadow.file, shadow.route)}: ${winner} defines ` +
    "the same route, which serve uses instead";
}

export function webhookRouteSourceLabel(
  endpoint: Pick<WebhookEndpoint, "source" | "file">,
): string {
  if (endpoint.source === "file") return `file:${endpoint.file ?? ""}`;
  return endpoint.source ?? "config";
}

export interface RouteFileCheck {
  /** serve would start without any file route */
  readonly directoryError?: string;
  readonly refused: readonly RefusedRouteFile[];
  readonly shadowed: readonly (ShadowedRouteFile & {
    readonly workflow: string;
  })[];
}

/** a missing vault key or an uninstalled scheme passes here; serve refuses it */
export async function checkRouteFiles(
  dir: string,
  extensionDirs: readonly string[],
  operator: readonly RouteOrigin[],
): Promise<RouteFileCheck> {
  let load: RouteFileLoad;
  try {
    await checkWebhookRoutesDir(dir, extensionDirs);
    load = await loadWebhookRouteFiles(dir);
  } catch (error) {
    return {
      directoryError: error instanceof Error ? error.message : String(error),
      refused: [],
      shadowed: [],
    };
  }
  const { shadowed } = mergeWebhookRoutes<RouteOrigin>(
    operator,
    load.files.map(({ file, entry }) => ({
      route: entry.route,
      source: "file",
      file,
    })),
  );
  return {
    refused: load.refused,
    shadowed: shadowed.map((shadow) => ({
      ...shadow,
      workflow: load.files.find((f) => f.file === shadow.file)?.entry
        .workflow ?? "",
    })),
  };
}
