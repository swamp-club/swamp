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

export const README_FILENAMES: readonly string[] = [
  "README.md",
  "README.MD",
  "readme.md",
  "Readme.md",
];

export const LICENSE_FILENAMES: readonly string[] = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENSE.MD",
  "LICENSE.TXT",
  "License",
  "License.md",
  "License.txt",
  "license",
  "license.md",
  "license.txt",
  "COPYING",
  "COPYING.md",
  "COPYING.txt",
];

/**
 * Directories, relative to the manifest root, searched for the README and
 * LICENSE in order: the root, then `files/`, where `additionalFiles:` land.
 */
export const DOC_FILE_DIRS: readonly string[] = ["", "files"];

/**
 * matching is exact against the directory listing, so a case-insensitive
 * filesystem finds the same file the registry's Linux scorer does
 */
export function presentInOrder(
  accepted: readonly string[],
  listing: Iterable<string>,
): string[] {
  const names = new Set(listing);
  return accepted.filter((name) => names.has(name));
}

export const STRIPPED_CONFIG_FILES: readonly string[] = [
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  "package.json",
  "package-lock.json",
  ".npmrc",
];

export const STRIPPED_CONFIG_DIRS: readonly string[] = ["node_modules"];

/** The deno.json written at the manifest root so `deno doc` resolves npm and jsr imports alike everywhere. */
export const CONTROLLED_DENO_JSON: string = JSON.stringify(
  { nodeModulesDir: "auto" },
  null,
  2,
) + "\n";

export const DENO_DOC_IMPORT_HOSTS: readonly string[] = [
  "deno.land:443",
  "jsr.io:443",
  "esm.sh:443",
  "raw.esm.sh:443",
  "cdn.jsdelivr.net:443",
  "raw.githubusercontent.com:443",
  "gist.githubusercontent.com:443",
  "registry.npmjs.org:443",
];

export function denoDocJsonArgs(entrypoints: readonly string[]): string[] {
  return [
    "doc",
    `--allow-import=${DENO_DOC_IMPORT_HOSTS.join(",")}`,
    "--json",
    ...entrypoints,
  ];
}

export function denoDocLintArgs(entrypoints: readonly string[]): string[] {
  return [
    "doc",
    `--allow-import=${DENO_DOC_IMPORT_HOSTS.join(",")}`,
    "--lint",
    ...entrypoints,
  ];
}

export const ENTRYPOINT_FIELDS = [
  "models",
  "drivers",
  "vaults",
  "datastores",
  "reports",
  "webhooks",
] as const;

export class EntrypointEscapesRootError extends Error {
  readonly entry: string;
  constructor(entry: string) {
    super(`Entrypoint escapes extraction root: ${entry}`);
    this.name = "EntrypointEscapesRootError";
    this.entry = entry;
  }
}

/**
 * each entry is prefixed with its field's directory, as push archives it
 * (`models: [models/foo.ts]` is at `models/models/foo.ts`); throws
 * EntrypointEscapesRootError when an entry climbs out of the root
 */
export function entrypointPaths(
  manifest: Readonly<Record<string, unknown>>,
): string[] {
  const paths: string[] = [];
  for (const field of ENTRYPOINT_FIELDS) {
    const list = manifest[field];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== "string") continue;
      const normalized = normalizePosix(
        `${field}/${entry.replace(/^\.\//, "")}`,
      );
      if (normalized === null) throw new EntrypointEscapesRootError(entry);
      paths.push(normalized);
    }
  }
  return paths;
}

function normalizePosix(path: string): string | null {
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

export const MANIFEST_SEARCH_SKIP: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "_fresh",
]);

export const MAX_MANIFEST_DEPTH = 2;

export interface ManifestSearchFs {
  hasManifest(dir: string): Promise<boolean>;
  subdirectories(dir: string): Promise<string[]>;
}

/** shallower wins; at one depth, the first in name order */
export async function findManifestRoot(
  fs: ManifestSearchFs,
): Promise<string | null> {
  let level = [""];
  for (let depth = 0; depth <= MAX_MANIFEST_DEPTH; depth++) {
    for (const dir of level) {
      if (await fs.hasManifest(dir)) return dir;
    }
    if (depth === MAX_MANIFEST_DEPTH) break;
    const next: string[] = [];
    for (const dir of level) {
      const names = (await fs.subdirectories(dir))
        .filter((name) => !MANIFEST_SEARCH_SKIP.has(name))
        .sort();
      for (const name of names) next.push(dir === "" ? name : `${dir}/${name}`);
    }
    level = next;
  }
  return null;
}
