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

/** Upstream's GitHub repository, the only place the binary is fetched from. */
export const LITESTREAM_REPOSITORY = "benbjohnson/litestream";

export const LITESTREAM_TARGETS = [
  "darwin-arm64",
  "darwin-x86_64",
  "linux-arm64",
  "linux-x86_64",
  "windows-x86_64",
] as const;

export type LitestreamTarget = typeof LITESTREAM_TARGETS[number];

/**
 * first release that replicates on Windows: earlier ones fail every directory
 * fsync there, so replication stops after two LTX files and restore fails;
 * below it Windows stays on v2
 */
export const LITESTREAM_WINDOWS_MIN_VERSION = "0.5.18";

export interface LitestreamTargetDigests {
  readonly archiveSha256: string;
  readonly binarySha256: string;
}

export interface LitestreamPinData {
  readonly version: string;
  readonly targets: Readonly<Record<LitestreamTarget, LitestreamTargetDigests>>;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * refuses a malformed version or digest and a missing target, so a bad pin
 * fails where it is built, never at download time
 */
export class LitestreamPin {
  private constructor(private readonly data: LitestreamPinData) {}

  static from(data: LitestreamPinData): LitestreamPin {
    if (!VERSION.test(data.version)) {
      throw new Error(
        `Litestream pin: version must be MAJOR.MINOR.PATCH, got ${data.version}`,
      );
    }
    for (const target of LITESTREAM_TARGETS) {
      const digests = data.targets[target];
      if (digests === undefined) {
        throw new Error(`Litestream pin: no digests for ${target}`);
      }
      for (const [field, value] of Object.entries(digests)) {
        if (!SHA256.test(value)) {
          throw new Error(
            `Litestream pin: ${target} ${field} is not a lowercase SHA-256: ${value}`,
          );
        }
      }
    }
    return new LitestreamPin(data);
  }

  get version(): string {
    return this.data.version;
  }

  digests(target: LitestreamTarget): LitestreamTargetDigests {
    return this.data.targets[target];
  }
}

export function litestreamTargetFor(
  os: string,
  arch: string,
): LitestreamTarget | undefined {
  const upstreamArch = arch === "aarch64" ? "arm64" : arch;
  const target = `${os}-${upstreamArch}`;
  return (LITESTREAM_TARGETS as readonly string[]).includes(target)
    ? target as LitestreamTarget
    : undefined;
}

export function isWindowsTarget(target: LitestreamTarget): boolean {
  return target.startsWith("windows-");
}

export function litestreamArchiveName(
  version: string,
  target: LitestreamTarget,
): string {
  const ext = isWindowsTarget(target) ? "zip" : "tar.gz";
  return `litestream-${version}-${target}.${ext}`;
}

export function litestreamArchiveUrl(
  version: string,
  target: LitestreamTarget,
): string {
  return `https://github.com/${LITESTREAM_REPOSITORY}/releases/download/v${version}/${
    litestreamArchiveName(version, target)
  }`;
}

export function litestreamBinaryName(target: LitestreamTarget): string {
  return isWindowsTarget(target) ? "litestream.exe" : "litestream";
}

export function compareLitestreamVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export type LitestreamAvailability =
  | { readonly available: true; readonly target: LitestreamTarget }
  | { readonly available: false; readonly reason: string };

export function litestreamAvailability(
  pin: LitestreamPin,
  os: string,
  arch: string,
): LitestreamAvailability {
  const target = litestreamTargetFor(os, arch);
  if (target === undefined) {
    return {
      available: false,
      reason: `Litestream replication is not available on ${os}/${arch}. ` +
        `swamp ships Litestream for ${LITESTREAM_TARGETS.join(", ")}.`,
    };
  }
  if (
    isWindowsTarget(target) &&
    compareLitestreamVersions(pin.version, LITESTREAM_WINDOWS_MIN_VERSION) < 0
  ) {
    return {
      available: false,
      reason: `v3 replication is not available on Windows yet: this swamp ` +
        `pins Litestream ${pin.version}, which cannot replicate on Windows ` +
        `(litestream#1542). It needs Litestream ` +
        `${LITESTREAM_WINDOWS_MIN_VERSION} or later. Use a v2 datastore on ` +
        `Windows until then.`,
    };
  }
  return { available: true, target };
}
