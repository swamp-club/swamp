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

import { isServeFederationEnabled } from "../../domain/serve/federation_gate.ts";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { walk } from "@std/fs";
import { UserError } from "../../domain/errors.ts";
import {
  APP_DESCRIPTOR_FILE,
  APP_SOURCE_DIR,
  appCollective,
  appNameKey,
  AppNameSchema,
  parseAppDescriptor,
} from "../../domain/apps/app_descriptor.ts";
import type {
  AppCatalog,
  AppCatalogListing,
  AppCatalogProblem,
  AppOrigin,
  InstalledApp,
} from "../../domain/apps/app_catalog.ts";
import { readManifestIdentityAt } from "./local_manifest_reader.ts";
import { resolvePulledExtensionsRoot, swampPath } from "./paths.ts";

/** an installed extension keeps its apps at `<extension>/apps/<folder>/` */
const PULLED_APPS_DIR = "apps";
export const APP_DEV_DIR = "app-dev";

const MAX_APP_SEARCH_DEPTH = 8;

export interface AppCatalogRoots {
  readonly repoDir: string;
  /** Mounted extension sources; each may hold an `extensions/apps/` folder. */
  readonly sourceDirs?: () => Promise<readonly string[]>;
  /** Only the local dashboard follows `swamp app dev`; serve never does. */
  readonly followDevServers?: boolean;
}

export interface AppDevRegistration {
  readonly name: string;
  readonly url: string;
  readonly root: string;
}

/** `swamp app dev` touches its registration this often, so a crash goes stale. */
export const APP_DEV_HEARTBEAT_MS = 5_000;
const APP_DEV_STALE_MS = 3 * APP_DEV_HEARTBEAT_MS;

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await Deno.lstat(path)).isFile;
  } catch {
    return false;
  }
}

export class FilesystemAppCatalog implements AppCatalog {
  constructor(private readonly roots: AppCatalogRoots) {}

  async list(): Promise<AppCatalogListing> {
    const found = new Map<string, InstalledApp>();
    const pulledRoot = resolvePulledExtensionsRoot(this.roots.repoDir);
    const problems: AppCatalogProblem[] = [];
    const add = async (
      path: string,
      origin: AppOrigin,
      version?: string,
    ): Promise<void> => {
      try {
        const descriptor = parseAppDescriptor(
          await Deno.readTextFile(path),
          path,
          {
            federation: isServeFederationEnabled((name) => Deno.env.get(name)),
          },
        );
        const root = dirname(path);
        if (origin === "extension") {
          await assertPulledApp(pulledRoot, path, descriptor.name);
        }
        // a repo's own folder wins, as local extension code does over pulled
        if (found.has(descriptor.name)) return;
        found.set(descriptor.name, {
          descriptor,
          root,
          origin,
          built: await exists(join(root, descriptor.entry)),
          ...(version !== undefined ? { version } : {}),
        });
      } catch (error) {
        problems.push({
          path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    for (
      const path of await descriptorsIn(
        join(this.roots.repoDir, APP_SOURCE_DIR),
      )
    ) {
      await add(path, "local");
    }
    for (const dir of await this.roots.sourceDirs?.() ?? []) {
      for (const path of await descriptorsIn(join(dir, APP_SOURCE_DIR))) {
        await add(path, "source");
      }
    }
    // sorted, so which copy wins never depends on directory order
    const pulled: string[] = [];
    for await (const path of pulledDescriptors(pulledRoot)) pulled.push(path);
    for (const path of pulled.sort()) {
      await add(path, "extension", versionOf(path));
    }
    if (this.roots.followDevServers) await this.#applyDevServers(found);
    return {
      apps: [...found.values()].sort((a, b) =>
        a.descriptor.name.localeCompare(b.descriptor.name)
      ),
      problems,
    };
  }

  async #applyDevServers(found: Map<string, InstalledApp>): Promise<void> {
    for (const registration of await readDevRegistrations(this.roots.repoDir)) {
      const app = found.get(registration.name);
      // a dev launch skips approval, so it only ever stands for the repo's own
      if (
        app === undefined || app.origin !== "local" ||
        resolve(app.root) !== resolve(registration.root)
      ) {
        continue;
      }
      found.set(registration.name, {
        ...app,
        built: true,
        devUrl: registration.url,
      });
    }
  }
}

/** presence only: the app.yaml may still be refused when the catalog loads it */
export async function hasAppDescriptors(sourceDir: string): Promise<boolean> {
  try {
    return (await descriptorsIn(join(sourceDir, APP_SOURCE_DIR))).length > 0;
  } catch (error) {
    if (error instanceof Deno.errors.NotADirectory) return false;
    throw error;
  }
}

async function descriptorsIn(appsDir: string): Promise<string[]> {
  const paths: string[] = [];
  try {
    for await (const entry of Deno.readDir(appsDir)) {
      if (!entry.isDirectory) continue;
      const path = join(appsDir, entry.name, APP_DESCRIPTOR_FILE);
      if (await exists(path)) paths.push(path);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return paths.sort();
}

async function* pulledDescriptors(pulledRoot: string): AsyncGenerator<string> {
  try {
    for await (
      const entry of walk(pulledRoot, {
        maxDepth: MAX_APP_SEARCH_DEPTH,
        includeDirs: false,
        followSymlinks: false,
        match: [/[\\/]apps[\\/][^\\/]+[\\/]app\.yaml$/],
      })
    ) {
      yield entry.path;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

// approvals follow the name and `files/` is written verbatim, so the root must
// sit where its own manifest says
async function assertPulledApp(
  pulledRoot: string,
  descriptorPath: string,
  appName: string,
): Promise<void> {
  const appDir = dirname(descriptorPath);
  const extensionRoot = dirname(dirname(appDir));
  const refuse = () =>
    new UserError(
      `App ${appName} does not belong to the extension that installed it.`,
    );
  const manifest = await readInstalledManifest(extensionRoot);
  if (
    manifest === null ||
    basename(dirname(appDir)) !== PULLED_APPS_DIR ||
    !AppNameSchema.safeParse(manifest.name).success ||
    installedName(pulledRoot, extensionRoot) !== manifest.name ||
    manifest.name.split("/")[0] !== `@${appCollective(appName)}` ||
    !manifest.apps.some((app) => basename(app) === basename(appDir))
  ) {
    throw refuse();
  }
}

/** the extension's name as its install path spells it, with nothing resolved */
function installedName(pulledRoot: string, extensionRoot: string): string {
  return relative(resolve(pulledRoot), resolve(extensionRoot))
    .split(SEPARATOR).join("/");
}

async function readInstalledManifest(
  extensionRoot: string,
): Promise<{ name: string; apps: string[] } | null> {
  let value: unknown;
  try {
    value = parseYaml(
      await Deno.readTextFile(join(extensionRoot, "manifest.yaml")),
    );
  } catch {
    return null;
  }
  const { name, apps } = (value ?? {}) as { name?: unknown; apps?: unknown };
  if (typeof name !== "string" || !Array.isArray(apps)) return null;
  return { name, apps: apps.filter((app) => typeof app === "string") };
}

/** `<extension>/apps/<app>/app.yaml`, so the manifest is three folders up */
function versionOf(descriptorPath: string): string | undefined {
  const extensionRoot = dirname(dirname(dirname(descriptorPath)));
  return readManifestIdentityAt(join(extensionRoot, "manifest.yaml"))?.version;
}

function registrationPath(repoDir: string, name: string): string {
  return swampPath(repoDir, APP_DEV_DIR, `${appNameKey(name)}.json`);
}

export async function writeDevRegistration(
  repoDir: string,
  registration: AppDevRegistration,
): Promise<string> {
  const path = registrationPath(repoDir, registration.name);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(registration));
  return path;
}

async function readDevRegistrations(
  repoDir: string,
): Promise<AppDevRegistration[]> {
  const dir = swampPath(repoDir, APP_DEV_DIR);
  const registrations: AppDevRegistration[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const value = await readRegistration(join(dir, entry.name));
      if (value !== null) registrations.push(value);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return registrations;
}

async function readRegistration(
  path: string,
): Promise<AppDevRegistration | null> {
  let parsed: unknown;
  let touched: Date | null;
  try {
    parsed = JSON.parse(await Deno.readTextFile(path));
    touched = (await Deno.stat(path)).mtime;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const value = parsed as Partial<AppDevRegistration>;
  if (
    typeof value.name !== "string" || typeof value.url !== "string" ||
    typeof value.root !== "string" || !isLoopbackUrl(value.url) ||
    touched === null || Date.now() - touched.getTime() > APP_DEV_STALE_MS
  ) {
    return null;
  }
  return value as AppDevRegistration;
}
