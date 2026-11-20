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
  basename,
  dirname,
  extname,
  join,
  relative,
  SEPARATOR,
} from "@std/path";
import { walk } from "@std/fs";
import {
  APP_DESCRIPTOR_FILE,
  appCollective,
  type AppDescriptor,
  parseAppDescriptor,
} from "../apps/app_descriptor.ts";
import { realAppBuildDir } from "../apps/app_build_dir.ts";
import { markErrorPaths, UserError } from "../errors.ts";
import { BUN_LOCKFILE } from "@swamp-club/extension-scoring/dependency-audit";

/** What serve will answer for; nothing else belongs in a build. */
const APP_FILE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
]);

/** Beside `app.yaml`, what the registry needs to audit the app's packages. */
const APP_PACKAGE_FILES = ["package.json", BUN_LOCKFILE];

const MAX_APP_FILE_BYTES = 5_000_000;
const MAX_APP_TOTAL_BYTES = 25_000_000;
const MAX_APP_FILES = 500;

export interface AppBundle {
  readonly descriptor: AppDescriptor;
  /** The folder's name in the archive. */
  readonly folder: string;
  /** Absolute paths: `app.yaml`, `package.json`, `bun.lock` when present, and the entry's folder. */
  readonly files: readonly string[];
  /** Each file's path inside the archive's `apps/<folder>/`. */
  readonly archivePaths: readonly string[];
}

/** Static checks only: the sandbox, not this scan, is what contains an app. */
export async function readAppBundle(
  appDir: string,
  extensionName: string,
): Promise<AppBundle> {
  const descriptorPath = join(appDir, APP_DESCRIPTOR_FILE);
  let text: string;
  try {
    text = await Deno.readTextFile(descriptorPath);
  } catch {
    throw markErrorPaths(
      new UserError(`No ${APP_DESCRIPTOR_FILE} in ${appDir}.`),
      [appDir],
    );
  }
  const descriptor = parseAppDescriptor(text, descriptorPath);
  const owner = extensionName.slice(1).split("/")[0];
  if (appCollective(descriptor.name) !== owner) {
    throw new UserError(
      `App ${descriptor.name} must use the extension's collective @${owner}.`,
    );
  }
  const entryPath = join(appDir, descriptor.entry);
  try {
    await Deno.lstat(entryPath);
  } catch {
    throw new UserError(
      `App ${descriptor.name} has no build at ${descriptor.entry}. Run swamp app build first.`,
    );
  }
  const buildDir = dirname(entryPath);
  // walk enters a symlinked root even with followSymlinks off
  if (
    (await Deno.lstat(buildDir)).isSymlink ||
    await realAppBuildDir(appDir, descriptor.entry) === null
  ) {
    throw markErrorPaths(
      new UserError(
        `The build folder of ${descriptor.name} must be a folder inside the app, not a symlink: ${buildDir}.`,
      ),
      [buildDir],
    );
  }
  const files: string[] = [descriptorPath];
  let total = 0;
  // shipped so the registry audits the packages the build inlines; serve
  // answers only for the build folder, so neither is ever served
  for (const name of APP_PACKAGE_FILES) {
    const path = join(appDir, name);
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path);
    } catch {
      continue;
    }
    if (!info.isFile) {
      throw markErrorPaths(
        new UserError(
          `App ${descriptor.name}'s ${name} is not a regular file.`,
        ),
        [path],
      );
    }
    total += info.size;
    files.push(path);
  }
  for await (
    const entry of walk(buildDir, { followSymlinks: false, includeDirs: false })
  ) {
    if (entry.isSymlink) {
      throw markErrorPaths(
        new UserError(`App build holds a symlink: ${entry.path}.`),
        [entry.path],
      );
    }
    const extension = extname(entry.path).toLowerCase();
    const hidden = relative(buildDir, entry.path).split(SEPARATOR).some((
      segment,
    ) => segment.startsWith("."));
    if (hidden || !APP_FILE_EXTENSIONS.has(extension)) {
      throw markErrorPaths(
        new UserError(
          `The build of ${descriptor.name} holds a file swamp won't serve: ${entry.path}.`,
        ),
        [entry.path],
      );
    }
    const { size } = await Deno.lstat(entry.path);
    if (size > MAX_APP_FILE_BYTES) {
      throw markErrorPaths(
        new UserError(
          `${entry.path} is over the ${MAX_APP_FILE_BYTES} byte limit for an app file.`,
        ),
        [entry.path],
      );
    }
    total += size;
    files.push(entry.path);
  }
  if (files.length > MAX_APP_FILES || total > MAX_APP_TOTAL_BYTES) {
    throw new UserError(
      `The build of ${descriptor.name} is too large: the limits are ${MAX_APP_FILES} files and ${MAX_APP_TOTAL_BYTES} bytes.`,
    );
  }
  return {
    descriptor,
    folder: basename(appDir),
    files,
    archivePaths: files.map((file) => relative(appDir, file)),
  };
}

/** two folders with one name would overwrite each other in the archive */
export function duplicateAppFolder(apps: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const app of apps) {
    const folder = basename(app);
    if (seen.has(folder)) return folder;
    seen.add(folder);
  }
  return null;
}

/** Every file the manifest's apps ship, for a package's content key. */
export async function appBundleFiles(
  manifest: { readonly name: string; readonly apps: readonly string[] },
  appsDir: string,
): Promise<string[]> {
  const files: string[] = [];
  for (const app of manifest.apps) {
    try {
      const bundle = await readAppBundle(join(appsDir, app), manifest.name);
      for (const file of bundle.files) files.push(file);
    } catch {
      // Push's own gate reports it; a key only has to change with the content.
    }
  }
  return files;
}
