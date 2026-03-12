// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { UserError } from "../errors.ts";

const ARTIFACT_BASE_URL =
  "https://artifacts.systeminit.com/swamp/stable/binary";

const SUPPORTED_OS = new Set(["darwin", "linux"]);
const SUPPORTED_ARCH = new Set(["aarch64", "x86_64"]);

/**
 * Value object representing a supported platform for binary artifacts.
 */
export class Platform {
  readonly os: string;
  readonly arch: string;

  private constructor(os: string, arch: string) {
    this.os = os;
    this.arch = arch;
  }

  /**
   * Detect the current platform from Deno.build.
   * Throws UserError for unsupported platforms.
   */
  static detect(): Platform {
    return Platform.from(Deno.build.os, Deno.build.arch);
  }

  /**
   * Create a Platform from explicit OS and arch values.
   * Throws UserError for unsupported combinations.
   */
  static from(os: string, arch: string): Platform {
    if (!SUPPORTED_OS.has(os)) {
      throw new UserError(
        `Unsupported operating system: ${os}. Supported: ${
          [...SUPPORTED_OS].join(", ")
        }`,
      );
    }
    if (!SUPPORTED_ARCH.has(arch)) {
      throw new UserError(
        `Unsupported architecture: ${arch}. Supported: ${
          [...SUPPORTED_ARCH].join(", ")
        }`,
      );
    }
    return new Platform(os, arch);
  }

  /**
   * Returns the tarball filename for the stable binary.
   * e.g. "swamp-stable-binary-darwin-aarch64.tar.gz"
   */
  get tarballName(): string {
    return `swamp-stable-binary-${this.os}-${this.arch}.tar.gz`;
  }

  /**
   * Returns the full URL for the stable binary tarball.
   * e.g. "https://artifacts.systeminit.com/swamp/stable/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz"
   */
  stableUrl(): string {
    return `${ARTIFACT_BASE_URL}/${this.os}/${this.arch}/${this.tarballName}`;
  }

  equals(other: Platform): boolean {
    return this.os === other.os && this.arch === other.arch;
  }

  toString(): string {
    return `${this.os}/${this.arch}`;
  }
}
