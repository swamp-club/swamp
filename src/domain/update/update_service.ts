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

export interface UpdateChecker {
  checkForUpdate(
    platform: Platform,
    signal?: AbortSignal,
  ): Promise<string | null>;

  fetchChecksum(tarballUrl: string, signal?: AbortSignal): Promise<string>;

  /**
   * aborting options.signal before the binary is replaced rejects with its
   * reason and leaves the installed binary untouched
   */
  downloadAndInstall(
    url: string,
    binaryPath: string,
    expectedChecksum: string,
    options?: DownloadOptions,
  ): Promise<void>;
}

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

export function isDevBuild(version: string): boolean {
  const shaIndex = version.indexOf("-sha.");
  if (shaIndex === -1) {
    return true;
  }
  const shaValue = version.substring(shaIndex + 5);
  return shaValue.length === 0;
}

export function parseVersionFromRedirectUrl(url: string): string | null {
  const match = url.match(/\/swamp\/([^/]+)\/binary\//);
  return match ? match[1] : null;
}

export interface PermissionDeniedFacts {
  os: typeof Deno.build.os;
  binaryPath: string;
  /**
   * when the directory accepts new files, the binary itself is protected (an
   * immutable flag, a sticky directory)
   */
  dirWritable: boolean;
  dirSticky?: boolean;
  homeDir?: string;
  dirOwnerUid: number | null;
  binaryOwnerUid?: number | null;
  currentUid: number | null;
  userName?: string;
}

/**
 * in a sticky directory only the file's owner, the directory's owner and root
 * may rename over a file; a non-root CAP_FOWNER process may too but is treated
 * as blocked
 */
export function stickyDirectoryBlocksReplace(
  facts: PermissionDeniedFacts,
): boolean {
  const { binaryOwnerUid, currentUid, dirOwnerUid } = facts;
  // The sticky rule only matters once the directory accepts new files
  return facts.os !== "windows" && facts.dirWritable &&
    facts.dirSticky === true &&
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
 * suggests sudo only for a root-owned directory outside the home directory;
 * sudo on a binary in a user's directory leaves it owned by root
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

export interface BinaryOwnership {
  dirMode: number | null;
  dirOwnerUid: number | null;
  binaryOwnerUid: number | null;
}

export type ReadBinaryOwnership = (
  binaryPath: string,
) => Promise<BinaryOwnership>;

async function readBinaryOwnership(
  binaryPath: string,
): Promise<BinaryOwnership> {
  const dir = await Deno.stat(dirname(binaryPath)).catch(() => null);
  // The sticky rule applies to the directory entry, so read a symlink's own
  // owner (lstat), not its target's
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

export async function describePermissionDenied(
  binaryPath: string,
  dirWritable?: boolean,
  readOwnership: ReadBinaryOwnership = readBinaryOwnership,
): Promise<string> {
  return permissionDeniedMessage(
    await permissionDeniedFacts(binaryPath, dirWritable, readOwnership),
  );
}

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
   * every OS installs by renaming a new file into the binary's directory, so
   * only write access to that directory matters; a sticky directory blocks
   * renaming over another user's binary
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

  /** downloads from the resolved versioned URL, not the stable redirect pointer */
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
