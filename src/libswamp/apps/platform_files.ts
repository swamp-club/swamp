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
import { markErrorPaths } from "../../domain/errors.ts";
import { copy, ensureDir, exists } from "@std/fs";
import {
  AUTHORING_ARCHIVE,
  authoringFolders,
} from "../../domain/apps/app_platform.ts";
import { extractTarGz } from "../../infrastructure/archive/tar_archive.ts";
import { resourcePath } from "../../infrastructure/runtime/resource_root.ts";

/** Written into every app, never committed or bundled: types, tests and dev. */
export const APP_PLATFORM_DIR = ".swamp-platform";

// embedded in the compiled binary, so located from the resource root
const PACKAGES_DIR = resourcePath("packages");

/** The SDK's source: its types, the mock host for tests, and the Vite plugin. */
export const SDK_FILES: Readonly<Record<string, readonly string[]>> = {
  "app-sdk": [
    "bridge.ts",
    "bridge_transport.ts",
    "capabilities.ts",
    "connect.ts",
    "data_changes.ts",
    "headers.ts",
    "method_run_state.ts",
    "mock_host.ts",
    "mod.ts",
    "react.tsx",
    "run_state.ts",
    "theme.css",
    "vite.ts",
  ],
  client: [
    "client.ts",
    "http_errors.ts",
    "http_transport.ts",
    "protocol.ts",
    "queue.ts",
    "stream.ts",
  ],
};

export interface AppPlatformFiles {
  readonly major: number;
  /** The minor this swamp carries; absent when it carries no build of it. */
  readonly minor?: number;
}

// rewritten every time, so an app never holds a stale copy
export async function writeAppPlatform(
  appDir: string,
  major: number,
  packagesDir: string = PACKAGES_DIR,
): Promise<AppPlatformFiles> {
  const target = join(appDir, APP_PLATFORM_DIR);
  await Deno.remove(target, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  for (const [pkg, files] of Object.entries(SDK_FILES)) {
    await ensureDir(join(target, pkg));
    for (const file of files) {
      await copy(join(packagesDir, pkg, file), join(target, pkg, file));
    }
  }
  const built = join(packagesDir, "app-platform", "dist", String(major));
  if (!(await exists(join(built, "platform.json")))) return { major };
  await unpackAuthoring(join(built, AUTHORING_ARCHIVE), target, major);
  const manifest = await Deno.readTextFile(join(built, "platform.json"));
  await Deno.writeTextFile(join(target, "platform.json"), manifest);
  const { minor } = JSON.parse(manifest) as { minor?: unknown };
  return typeof minor === "number" ? { major, minor } : { major };
}

// our own archive, read as untrusted anyway: files only, under the folders it
// is meant to fill, so it can never replace the SDK copied beside them
async function unpackAuthoring(
  archive: string,
  target: string,
  major: number,
): Promise<void> {
  const allowed = Object.values(authoringFolders(major)).map((dir) =>
    `${dir}/`
  );
  const file = await Deno.open(archive).catch((error) => {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `The app platform ${major} build has no ${AUTHORING_ARCHIVE}; rebuild it with: deno run build-app-platform`,
      );
    }
    throw error;
  });
  await extractTarGz(file.readable, target, (entry) => {
    const path = entry.archivePath;
    if (
      (entry.kind !== "file" && entry.kind !== "directory") ||
      !allowed.some((dir) => path.startsWith(dir)) ||
      path.split("/").includes("..")
    ) {
      throw markErrorPaths(
        new Error(
          `${AUTHORING_ARCHIVE} holds an entry an app cannot take: ${path}`,
        ),
        [path],
      );
    }
  });
}
