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

import { dirname, isAbsolute, join, relative, SEPARATOR } from "@std/path";
import type { Platform } from "./platform.ts";
import type { DownloadOptions } from "./download_progress.ts";
import { validateRedirectUrl } from "./integrity.ts";
import { markErrorPaths, UserError } from "../errors.ts";

/**
 * Port for checking and performing updates.
 * Implemented by infrastructure adapters (e.g. HttpUpdateChecker).
 */
export interface UpdateChecker {
  /**
   * Check the latest available version by inspecting the stable URL redirect.
   * Returns the redirect URL containing the version, or null if no redirect.
   * Aborting `signal` rejects with its reason.
   */
  checkForUpdate(
    platform: Platform,
    signal?: AbortSignal,
  ): Promise<string | null>;

  /**
   * Fetch the expected SHA-256 checksum for a tarball.
   * Derives the checksum URL from the tarball URL by appending ".sha256".
   * Aborting `signal` rejects with its reason.
   */
  fetchChecksum(tarballUrl: string, signal?: AbortSignal): Promise<string>;

  /**
   * Download the tarball, verify its SHA-256 checksum, extract, and install.
   * Throws UserError if checksum verification fails. Aborting
   * `options.signal` before the binary is replaced rejects with its reason
   * and leaves the installed binary untouched.
   */
  downloadAndInstall(
    url: string,
    binaryPath: string,
    expectedChecksum: string,
    options?: DownloadOptions,
  ): Promise<void>;
}

/**
 * Discriminated union for update results.
 */
export type UpdateResult =
  | { status: "up_to_date"; currentVersion: string; warning?: string }
  | {
    status: "update_available";
    currentVersion: string;
    latestVersion: string;
    warning?: string;
  }
  | {
    status: "updated";
    previousVersion: string;
    newVersion: string;
    warning?: string;
  };

/**
 * Returns true when the version is a development build.
 * Dev builds have an empty sha (e.g. "20260206.200442.0-sha.") or lack the "-sha." segment entirely.
 */
export function isDevBuild(version: string): boolean {
  const shaIndex = version.indexOf("-sha.");
  if (shaIndex === -1) {
    return true;
  }
  const shaValue = version.substring(shaIndex + 5);
  return shaValue.length === 0;
}

/**
 * Extract a CalVer version string from a redirect URL.
 * Expected URL pattern: .../swamp/{version}/binary/...
 * Returns null if the pattern doesn't match.
 */
export function parseVersionFromRedirectUrl(url: string): string | null {
  const match = url.match(/\/swamp\/([^/]+)\/binary\//);
  return match ? match[1] : null;
}

/** What decides the hint when an update cannot replace the binary. */
export interface PermissionDeniedFacts {
  os: typeof Deno.build.os;
  binaryPath: string;
  /**
   * Whether the binary's directory accepts new files. When it does, the
   * binary itself is protected (an immutable flag, a sticky directory).
   */
  dirWritable: boolean;
  /** Whether the binary's directory has the sticky bit (mode 1000). */
  dirSticky?: boolean;
  /** The user's home directory; undefined when HOME is unset. */
  homeDir?: string;
  /** Owner of the binary's directory; null when it cannot be read. */
  dirOwnerUid: number | null;
  /** Owner of the binary; null when it cannot be read or does not exist. */
  binaryOwnerUid?: number | null;
  currentUid: number | null;
  /** The invoking user's login name (SUDO_USER, else USER). */
  userName?: string;
}

/**
 * Whether a sticky directory stops this user replacing the binary. In a
 * sticky directory only the file's owner, the directory's owner and root may
 * rename over a file (swamp-club#3822). A non-root process holding
 * CAP_FOWNER may too; it is treated as blocked, and the hint still applies.
 */
export function stickyDirectoryBlocksReplace(
  facts: PermissionDeniedFacts,
): boolean {
  const { binaryOwnerUid, currentUid, dirOwnerUid } = facts;
  return facts.os !== "windows" && facts.dirSticky === true &&
    binaryOwnerUid !== undefined && binaryOwnerUid !== null &&
    currentUid !== null && currentUid !== 0 &&
    binaryOwnerUid !== currentUid && dirOwnerUid !== currentUid;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${SEPARATOR}`) && !isAbsolute(rel));
}

/**
 * The message for an update that cannot write the binary's directory.
 * Suggests sudo only for a root-owned directory outside the home directory;
 * sudo on a binary in a user's directory leaves it owned by root.
 */
export function permissionDeniedMessage(facts: PermissionDeniedFacts): string {
  const prefix = `Cannot update ${facts.binaryPath}: permission denied.`;
  if (facts.os === "windows") {
    return `${prefix} Try running the terminal as Administrator.`;
  }
  const dir = dirname(facts.binaryPath);
  const { dirOwnerUid, currentUid, homeDir } = facts;
  const user = facts.userName || "$(whoami)";
  if (stickyDirectoryBlocksReplace(facts)) {
    return `${prefix} ${dir} is a sticky directory and the binary is owned ` +
      `by another user (uid ${facts.binaryOwnerUid}), so only that user, ` +
      `the directory's owner or root can replace it. Re-run with:\n\n` +
      `  sudo swamp update\n\n` +
      `or take ownership of the binary, then run swamp update without ` +
      `sudo:\n\n` +
      `  sudo chown ${user} ${facts.binaryPath}`;
  }
  // Neither sudo nor an ownership change helps in the next two cases
  if (facts.dirWritable) {
    return `${prefix} The binary is protected against replacement even ` +
      `though ${dir} accepts new files — check it for an immutable flag ` +
      `(chflags or chattr), or, if ${dir} is a sticky directory, whether ` +
      `another user owns the binary.`;
  }
  if (currentUid === 0) {
    return `${prefix} ${dir} does not accept new files even as root — ` +
      `check it for an immutable flag (chflags or chattr) or a read-only ` +
      `mount.`;
  }
  const underHome = homeDir !== undefined && homeDir !== "" &&
    isWithin(homeDir, dir);
  if (
    dirOwnerUid === null || currentUid === null ||
    (dirOwnerUid === 0 && !underHome)
  ) {
    return `${prefix} Re-run with: sudo swamp update`;
  }
  if (dirOwnerUid === currentUid) {
    return `${prefix} ${dir} is owned by you but is not writable. ` +
      `Make it writable, then run swamp update without sudo:\n\n` +
      `  chmod u+w ${dir}`;
  }
  return `${prefix} ${dir} is owned by another user (uid ${dirOwnerUid}), ` +
    `so swamp cannot replace the binary in it. Give the directory to your ` +
    `user, then run swamp update without sudo:\n\n` +
    `  sudo chown ${user} ${dir}`;
}

/**
 * The warning after `sudo swamp update` into a directory the invoking user
 * owns: the new binary is now root-owned there, and sudo was not needed.
 */
export function needlessRootUpdateWarning(
  binaryPath: string,
  currentUid: number | null,
  sudoUid: number | null,
  dirOwnerUid: number | null,
): string | undefined {
  if (
    currentUid !== 0 || sudoUid === null || sudoUid === 0 ||
    dirOwnerUid !== sudoUid
  ) {
    return undefined;
  }
  return `Updated ${binaryPath} as root, so it is now owned by root, but ` +
    `its directory is owned by uid ${dirOwnerUid}. sudo is not needed ` +
    `here: run swamp update without sudo next time, which also makes your ` +
    `user the owner of the binary again.`;
}

function currentUid(): number | null {
  try {
    return Deno.uid();
  } catch {
    return null;
  }
}

/** The uid of the user who ran sudo; null outside sudo. */
function sudoUid(): number | null {
  const value = Deno.env.get("SUDO_UID");
  if (value === undefined || !/^\d+$/.test(value)) return null;
  return Number(value);
}

async function directoryOwnerUid(binaryPath: string): Promise<number | null> {
  try {
    return (await Deno.stat(dirname(binaryPath))).uid;
  } catch {
    return null;
  }
}

/** Whether a new file can be created beside `binaryPath`. */
async function directoryAcceptsFiles(binaryPath: string): Promise<boolean> {
  const probeFile = join(
    dirname(binaryPath),
    `.swamp.tmp.${crypto.randomUUID()}`,
  );
  try {
    await Deno.writeTextFile(probeFile, "");
  } catch {
    return false;
  }
  await Deno.remove(probeFile).catch(() => {
    // An abandoned probe is swept by the next update
  });
  return true;
}

/** Mode and owners of a binary and its directory; null when unreadable. */
export interface BinaryOwnership {
  dirMode: number | null;
  dirOwnerUid: number | null;
  binaryOwnerUid: number | null;
}

/** Reads the {@link BinaryOwnership} of `binaryPath`. */
export type ReadBinaryOwnership = (
  binaryPath: string,
) => Promise<BinaryOwnership>;

async function readBinaryOwnership(
  binaryPath: string,
): Promise<BinaryOwnership> {
  const dir = await Deno.stat(dirname(binaryPath)).catch(() => null);
  // The sticky rule applies to the directory entry, so a symlink's own owner
  const binary = await Deno.lstat(binaryPath).catch(() => null);
  return {
    dirMode: dir?.mode ?? null,
    dirOwnerUid: dir?.uid ?? null,
    binaryOwnerUid: binary?.uid ?? null,
  };
}

async function permissionDeniedFacts(
  binaryPath: string,
  dirWritable: boolean | undefined,
  readOwnership: ReadBinaryOwnership,
): Promise<PermissionDeniedFacts> {
  const ownership = await readOwnership(binaryPath);
  return {
    os: Deno.build.os,
    binaryPath,
    dirWritable: dirWritable ?? await directoryAcceptsFiles(binaryPath),
    dirSticky: ownership.dirMode !== null &&
      (ownership.dirMode & 0o1000) !== 0,
    homeDir: Deno.env.get("HOME"),
    dirOwnerUid: ownership.dirOwnerUid,
    binaryOwnerUid: ownership.binaryOwnerUid,
    currentUid: currentUid(),
    userName: Deno.env.get("SUDO_USER") ?? Deno.env.get("USER"),
  };
}

/**
 * The permission-denied message for `binaryPath`, from the live directory
 * mode, owners, user and home directory. `dirWritable` skips the directory
 * probe when the caller has just run it.
 */
export async function describePermissionDenied(
  binaryPath: string,
  dirWritable?: boolean,
  readOwnership: ReadBinaryOwnership = readBinaryOwnership,
): Promise<string> {
  return permissionDeniedMessage(
    await permissionDeniedFacts(binaryPath, dirWritable, readOwnership),
  );
}

/**
 * Domain service for self-update operations.
 */
export class UpdateService {
  private readonly checker: UpdateChecker;
  private readonly currentVersion: string;
  private readonly binaryPath: string;
  private readonly readOwnership: ReadBinaryOwnership;

  constructor(
    checker: UpdateChecker,
    currentVersion: string,
    binaryPath: string,
    readOwnership: ReadBinaryOwnership = readBinaryOwnership,
  ) {
    this.checker = checker;
    this.currentVersion = currentVersion;
    this.binaryPath = binaryPath;
    this.readOwnership = readOwnership;
  }

  private devBuildWarning(): string | undefined {
    if (isDevBuild(this.currentVersion)) {
      return "Replacing a development build with a release build. Run `deno run compile` to restore a dev build.";
    }
    return undefined;
  }

  /**
   * Check whether an update is available without installing.
   */
  async check(
    platform: Platform,
    signal?: AbortSignal,
  ): Promise<UpdateResult> {
    const redirectUrl = await this.checker.checkForUpdate(platform, signal);
    if (!redirectUrl) {
      return {
        status: "up_to_date",
        currentVersion: this.currentVersion,
        warning: this.devBuildWarning(),
      };
    }

    validateRedirectUrl(redirectUrl);

    const latestVersion = parseVersionFromRedirectUrl(redirectUrl);
    if (!latestVersion || latestVersion === this.currentVersion) {
      return {
        status: "up_to_date",
        currentVersion: this.currentVersion,
        warning: this.devBuildWarning(),
      };
    }

    return {
      status: "update_available",
      currentVersion: this.currentVersion,
      latestVersion,
      warning: this.devBuildWarning(),
    };
  }

  /**
   * Check whether the process can replace the binary.
   * Throws a UserError with remediation advice if not.
   *
   * Every OS installs by renaming a new file into the binary's directory, so
   * only write access to that directory matters — not to the binary itself,
   * which may be read-only or owned by another user (swamp-club#3817) —
   * unless the directory is sticky, where another user's binary cannot be
   * renamed over (swamp-club#3822).
   */
  async checkWritePermission(): Promise<void> {
    const probeFile = join(
      dirname(this.binaryPath),
      `.swamp.tmp.${crypto.randomUUID()}`,
    );
    try {
      await Deno.writeTextFile(probeFile, "");
      await Deno.remove(probeFile);
    } catch (error) {
      if (error instanceof Deno.errors.PermissionDenied) {
        throw markErrorPaths(
          new UserError(
            await describePermissionDenied(
              this.binaryPath,
              false,
              this.readOwnership,
            ),
          ),
          [this.binaryPath],
        );
      }
      // Other errors (e.g. NotFound, disk full) are not permission issues
      return;
    }
    const facts = await permissionDeniedFacts(
      this.binaryPath,
      true,
      this.readOwnership,
    );
    if (stickyDirectoryBlocksReplace(facts)) {
      throw markErrorPaths(
        new UserError(permissionDeniedMessage(facts)),
        [this.binaryPath],
      );
    }
  }

  /**
   * Check for and install an update.
   * Downloads from the resolved versioned URL, not the stable redirect pointer.
   * `options` reports download progress and can cancel the update.
   */
  async update(
    platform: Platform,
    options: DownloadOptions = {},
  ): Promise<UpdateResult> {
    const { signal } = options;
    await this.checkWritePermission();

    const redirectUrl = await this.checker.checkForUpdate(platform, signal);
    if (!redirectUrl) {
      return {
        status: "up_to_date",
        currentVersion: this.currentVersion,
        warning: this.devBuildWarning(),
      };
    }

    validateRedirectUrl(redirectUrl);

    const latestVersion = parseVersionFromRedirectUrl(redirectUrl);
    if (!latestVersion || latestVersion === this.currentVersion) {
      return {
        status: "up_to_date",
        currentVersion: this.currentVersion,
        warning: this.devBuildWarning(),
      };
    }

    signal?.throwIfAborted();
    const expectedChecksum = await this.checker.fetchChecksum(
      redirectUrl,
      signal,
    );
    signal?.throwIfAborted();
    await this.checker.downloadAndInstall(
      redirectUrl,
      this.binaryPath,
      expectedChecksum,
      options,
    );

    const warnings = [
      this.devBuildWarning(),
      needlessRootUpdateWarning(
        this.binaryPath,
        currentUid(),
        sudoUid(),
        await directoryOwnerUid(this.binaryPath),
      ),
    ].filter((warning) => warning !== undefined);
    return {
      status: "updated",
      previousVersion: this.currentVersion,
      newVersion: latestVersion,
      warning: warnings.length > 0 ? warnings.join("\n") : undefined,
    };
  }
}
