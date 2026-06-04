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
  try {
    const content = await Deno.readTextFile(path);
    return JSON.parse(content) as NamespaceManifest;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
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
