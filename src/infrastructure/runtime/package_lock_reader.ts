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

import { join, resolve } from "@std/path";
import { MAX_LOCKFILE_BYTES } from "@swamp-club/extension-scoring/dependency-audit";

/**
 * Whether a package.json project's `package-lock.json` describes what push
 * bundled (swamp-club#3970). It counts as a lock only when every
 * node_modules package the bundle takes code from is in it at the version
 * installed there; otherwise push treats the project as having no lock and
 * warns with `reason`. No `package-lock.json` at all is no lock, with no
 * warning.
 */
export type PackageLockValidity =
  | { valid: true; lockPath: string }
  | { valid: false; lockPath: string; reason: string }
  | { valid: false; lockPath: null };

/** One installed package the bundle takes code from. */
export interface InstalledPackage {
  /**
   * The package directory, relative to the package.json directory, with
   * forward slashes: `node_modules/ms`, `node_modules/a/node_modules/ms`.
   */
  path: string;
  /** The version its package.json names. */
  version: string;
}

const NO_LOCK = "treated as no lock";

/**
 * Reads `<packageDir>/package-lock.json` and checks it against `installed`.
 * The lock is repo-controlled JSON, so it is read as data: every shape is
 * checked, and only an `installed` path that is relative and stays inside
 * `packageDir` is looked up in it.
 */
export async function readPackageLockValidity(
  packageDir: string,
  installed: readonly InstalledPackage[],
): Promise<PackageLockValidity> {
  const lockPath = join(resolve(packageDir), "package-lock.json");
  const invalid = (reason: string): PackageLockValidity => ({
    valid: false,
    lockPath,
    reason,
  });
  const unreadable = (why: string) =>
    invalid(`package-lock.json could not be read (${why}); ${NO_LOCK}`);

  let bytes: Uint8Array;
  try {
    const info = await Deno.stat(lockPath);
    if (!info.isFile) return unreadable("it is not a file");
    if (info.size > MAX_LOCKFILE_BYTES) {
      return unreadable(`it is over ${MAX_LOCKFILE_BYTES} bytes`);
    }
    bytes = await Deno.readFile(lockPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { valid: false, lockPath: null };
    }
    return unreadable(error instanceof Error ? error.message : String(error));
  }
  // The file can grow between the stat and the read.
  if (bytes.length > MAX_LOCKFILE_BYTES) {
    return unreadable(`it is over ${MAX_LOCKFILE_BYTES} bytes`);
  }

  let lock: unknown;
  try {
    lock = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return unreadable("it is not JSON");
  }
  if (!isRecord(lock)) return unreadable("it is not a JSON object");

  const lockfileVersion = lock.lockfileVersion;
  if (lockfileVersion !== 2 && lockfileVersion !== 3) {
    const named = typeof lockfileVersion === "number"
      ? `lockfileVersion ${lockfileVersion}`
      : "lockfileVersion 1";
    return invalid(
      `package-lock.json is ${named}, which push cannot match against ` +
        `node_modules; ${NO_LOCK}. Run npm install with npm 7 or later to ` +
        `upgrade it`,
    );
  }
  const packages = lock.packages;
  if (!isRecord(packages)) {
    return unreadable("it has no packages map");
  }

  const sorted = [...installed].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  for (const entry of sorted) {
    const locked = isSafeLockKey(entry.path) &&
        Object.hasOwn(packages, entry.path)
      ? packages[entry.path]
      : undefined;
    const lockedVersion = isRecord(locked) ? locked.version : undefined;
    if (typeof lockedVersion !== "string") {
      return invalid(
        `package-lock.json does not match node_modules: the lock has no ` +
          `${entry.path}; ${NO_LOCK}`,
      );
    }
    if (lockedVersion !== entry.version) {
      return invalid(
        `package-lock.json does not match node_modules: ${entry.path} is ` +
          `${entry.version}, the lock says ${printable(lockedVersion)}; ` +
          NO_LOCK,
      );
    }
  }
  return { valid: true, lockPath };
}

/**
 * A lock's version as the warning shows it: repo-controlled text, so one
 * with control characters or of unbounded length is not echoed.
 */
function printable(version: string): string {
  return /^[\x21-\x7e]{1,64}$/.test(version)
    ? version
    : "a version that is not printable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A `packages` key push may look up: relative, forward-slash, with no
 * empty, `.` or `..` segment. Any other installed path never names a
 * package the lock describes, so it reads as missing from the lock.
 */
function isSafeLockKey(path: string): boolean {
  if (path === "" || path.includes("\\") || path.includes("\0")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}
