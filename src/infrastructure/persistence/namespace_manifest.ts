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

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { markErrorPaths, UserError } from "../../domain/errors.ts";

const MANIFEST_FILENAME = ".namespace.json";

export interface NamespaceManifest {
  namespace: string;
  repoId: string;
  registeredAt: string;
}

export function namespaceManifestPath(
  datastorePath: string,
  namespace: string,
): string {
  return join(datastorePath, namespace, MANIFEST_FILENAME);
}

export async function writeNamespaceManifest(
  datastorePath: string,
  namespace: string,
  repoId: string,
): Promise<void> {
  const dir = join(datastorePath, namespace);
  await ensureDir(dir);
  const manifest: NamespaceManifest = {
    namespace,
    repoId,
    registeredAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    join(dir, MANIFEST_FILENAME),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

export async function readNamespaceManifest(
  datastorePath: string,
  namespace: string,
): Promise<NamespaceManifest | null> {
  const path = namespaceManifestPath(datastorePath, namespace);
  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }

  // A hand-edited or corrupt manifest is a handled refusal, not a crash
  // (swamp-club#3319). Only a missing file means "not registered".
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw unreadableManifestError(path, "it is not valid JSON");
  }
  if (!isNamespaceManifest(parsed)) {
    throw unreadableManifestError(
      path,
      "it must be a JSON object with string namespace and repoId fields " +
        "(and a string registeredAt, if present)",
    );
  }
  return parsed;
}

function isNamespaceManifest(value: unknown): value is NamespaceManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.namespace === "string" &&
    typeof record.repoId === "string" &&
    (record.registeredAt === undefined ||
      typeof record.registeredAt === "string");
}

function unreadableManifestError(path: string, reason: string): UserError {
  return markErrorPaths(
    new UserError(
      `Cannot read namespace manifest ${path}: ${reason}. ` +
        `Fix the file, or remove it to unregister the namespace.`,
    ),
    [path],
  );
}

export async function removeNamespaceManifest(
  datastorePath: string,
  namespace: string,
): Promise<void> {
  const path = namespaceManifestPath(datastorePath, namespace);
  try {
    await Deno.remove(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

export async function listNamespaceManifests(
  datastorePath: string,
): Promise<NamespaceManifest[]> {
  const manifests: NamespaceManifest[] = [];
  try {
    for await (const entry of Deno.readDir(datastorePath)) {
      if (!entry.isDirectory) continue;
      if (entry.name.startsWith(".")) continue;
      const manifest = await readNamespaceManifest(datastorePath, entry.name);
      if (manifest) manifests.push(manifest);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return manifests.sort((a, b) => a.namespace.localeCompare(b.namespace));
}
