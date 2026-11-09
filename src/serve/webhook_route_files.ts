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
import type { WebhookEndpoint } from "./webhook.ts";
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

export interface WebhookRouteFile {
  readonly file: string;
  readonly entry: WebhookConfigEntry;
}

export interface RefusedRouteFile {
  readonly file: string;
  readonly route?: string;
  readonly message: string;
}

export interface RouteFileLoad {
  readonly files: readonly WebhookRouteFile[];
  readonly refused: readonly RefusedRouteFile[];
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

async function realOrResolved(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return resolve(path);
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
        new UserError(
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

/** a bad file is refused alone; only an unreadable directory throws */
export async function loadWebhookRouteFiles(
  dir: string,
): Promise<RouteFileLoad> {
  const names: { name: string; isSymlink: boolean }[] = [];
  try {
    for await (const item of Deno.readDir(dir)) {
      if (item.name.startsWith(".")) continue;
      if (!ROUTE_FILE_EXTENSIONS.has(extname(item.name).toLowerCase())) {
        continue;
      }
      if (item.isDirectory) continue;
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

/** a missing vault key or an unresolvable scheme refuses only that file */
export async function parseRouteFiles(
  files: readonly WebhookRouteFile[],
  parse: (configs: readonly WebhookConfigEntry[]) => Promise<WebhookEndpoint[]>,
): Promise<{ endpoints: WebhookEndpoint[]; refused: RefusedRouteFile[] }> {
  const endpoints: WebhookEndpoint[] = [];
  const refused: RefusedRouteFile[] = [];
  for (const { file, entry } of files) {
    try {
      const [endpoint] = await parse([entry]);
      endpoints.push({ ...endpoint, source: "file", file });
    } catch (error) {
      refused.push(
        refusal(
          file,
          entry.route,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  return { endpoints, refused };
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
