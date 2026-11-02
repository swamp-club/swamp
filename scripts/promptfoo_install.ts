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

/**
 * optional dependencies are omitted except libsql's host binding, which
 * promptfoo eval needs. --no-save stops npm rewriting the lockfile; npm install
 * not npm ci, as ci refuses a lockfile lacking the host's platform-specific
 * entries
 */

import { join } from "@std/path";

export interface HostBuild {
  os: string;
  arch: string;
  env?: string;
}

const LIBSQL_OS: Record<string, string> = {
  linux: "linux",
  darwin: "darwin",
  windows: "win32",
};

const LIBSQL_ARCH: Record<string, string> = {
  x86_64: "x64",
  aarch64: "arm64",
};

export function libsqlBindingPackage(build: HostBuild): string | undefined {
  const os = LIBSQL_OS[build.os];
  const arch = LIBSQL_ARCH[build.arch];
  if (os === undefined || arch === undefined) return undefined;
  switch (os) {
    case "linux":
      return `@libsql/linux-${arch}-${build.env === "musl" ? "musl" : "gnu"}`;
    case "win32":
      return arch === "x64" ? "@libsql/win32-x64-msvc" : undefined;
    default:
      return `@libsql/${os}-${arch}`;
  }
}

export interface NpmInstallOptions {
  cacheDir?: string;
  packages?: string[];
}

export function npmInstallArgs(options: NpmInstallOptions = {}): string[] {
  const args = [
    "install",
    "--no-save",
    "--omit=optional",
    "--no-audit",
    "--no-fund",
  ];
  if (options.cacheDir !== undefined) {
    args.push("--cache", options.cacheDir);
  }
  if (options.packages !== undefined && options.packages.length > 0) {
    args.push(...options.packages);
  }
  return args;
}

async function runNpmInstall(
  configDir: string,
  options: NpmInstallOptions,
): Promise<void> {
  const { code } = await new Deno.Command("npm", {
    args: npmInstallArgs(options),
    cwd: configDir,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) {
    throw new Error(`npm install failed with exit code ${code}`);
  }
}

interface LibsqlManifest {
  version: string;
  optionalDependencies?: Record<string, string>;
}

/**
 * in GitHub Actions both installs use a temporary npm cache deleted afterwards,
 * so the runner keeps no tarballs
 */
export async function installPromptfooDeps(configDir: string): Promise<void> {
  const cacheDir = Deno.env.get("GITHUB_ACTIONS") === "true"
    ? await Deno.makeTempDir({ prefix: "promptfoo-npm-cache-" })
    : undefined;
  try {
    await runNpmInstall(configDir, { cacheDir });

    const manifestPath = join(
      configDir,
      "node_modules",
      "libsql",
      "package.json",
    );
    const libsql = JSON.parse(
      await Deno.readTextFile(manifestPath),
    ) as LibsqlManifest;
    const binding = libsqlBindingPackage(Deno.build);
    if (
      binding === undefined ||
      libsql.optionalDependencies?.[binding] === undefined
    ) {
      throw new Error(
        `libsql ${libsql.version} has no native binding for ${Deno.build.target}`,
      );
    }
    await runNpmInstall(configDir, {
      cacheDir,
      packages: [`${binding}@${libsql.version}`],
    });
  } finally {
    if (cacheDir !== undefined) {
      try {
        await Deno.remove(cacheDir, { recursive: true });
      } catch (error) {
        console.warn(`Could not remove npm cache ${cacheDir}: ${error}`);
      }
    }
  }
}
