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

import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import { DenoVersion } from "../../domain/runtime/deno_version.ts";

const logger = getLogger(["swamp", "runtime", "deno"]);

/** Filename of the embedded deno binary (platform-dependent at build time). */
const DENO_BINARY_NAME = Deno.build.os === "windows" ? "deno.exe" : "deno";

/**
 * DenoRuntime implementation that manages an embedded deno binary.
 *
 * - **Dev mode** (running from source): returns `Deno.execPath()` directly.
 * - **Standalone mode** (compiled binary): reads the embedded binary from
 *   `resources/deno/`, extracts it to `~/.swamp/deno/`, and returns that path.
 *   Skips extraction when `~/.swamp/deno/.version` already matches.
 */
export class EmbeddedDenoRuntime implements DenoRuntime {
  private cachedPath: string | null = null;

  async ensureDeno(): Promise<string> {
    if (this.cachedPath) {
      return this.cachedPath;
    }

    // deno-lint-ignore no-explicit-any
    if (!(Deno.build as any).standalone) {
      // Dev mode: use the deno that's running us
      this.cachedPath = Deno.execPath();
      logger.debug`Dev mode: using system deno at ${this.cachedPath}`;
      return this.cachedPath;
    }

    // Standalone mode: extract embedded binary
    this.cachedPath = await this.extractEmbeddedDeno();
    return this.cachedPath;
  }

  private async extractEmbeddedDeno(): Promise<string> {
    const swampDir = this.getSwampDenoDir();
    const targetBinary = join(swampDir, DENO_BINARY_NAME);
    const versionMarker = join(swampDir, ".version");

    // Read embedded version
    const embeddedVersion = await this.readEmbeddedVersion();

    // Check if already extracted with matching version
    try {
      const existingVersion = (await Deno.readTextFile(versionMarker)).trim();
      if (existingVersion === embeddedVersion.value) {
        // Also verify the binary exists
        await Deno.stat(targetBinary);
        logger
          .debug`Deno ${embeddedVersion} already extracted at ${targetBinary}`;
        return targetBinary;
      }
    } catch {
      // Version marker missing or binary missing — need to extract
    }

    logger.info`Extracting embedded deno ${embeddedVersion} to ${swampDir}`;

    // Ensure target directory exists
    await Deno.mkdir(swampDir, { recursive: true });

    // Read embedded binary
    const embeddedBinary = await this.readEmbeddedBinary();

    // Write binary to target
    await Deno.writeFile(targetBinary, embeddedBinary);

    // Set executable permissions (unix)
    if (Deno.build.os !== "windows") {
      await Deno.chmod(targetBinary, 0o755);
    }

    // Write version marker
    await Deno.writeTextFile(versionMarker, embeddedVersion.value);

    logger
      .info`Extracted deno ${embeddedVersion} (${embeddedBinary.length} bytes)`;
    return targetBinary;
  }

  private async readEmbeddedVersion(): Promise<DenoVersion> {
    const versionPath = this.getEmbeddedResourcePath("version.txt");
    const content = await Deno.readTextFile(versionPath);
    return DenoVersion.create(content.trim());
  }

  private async readEmbeddedBinary(): Promise<Uint8Array> {
    const binaryPath = this.getEmbeddedResourcePath(DENO_BINARY_NAME);
    return await Deno.readFile(binaryPath);
  }

  /**
   * Gets the path to an embedded resource file.
   * Uses import.meta.dirname to navigate from this file's location
   * (src/infrastructure/runtime/) up to repo root, then into resources/deno/.
   */
  private getEmbeddedResourcePath(filename: string): string {
    const currentDir = import.meta.dirname ?? ".";
    // From src/infrastructure/runtime -> ../../.. -> repo root
    return join(currentDir, "..", "..", "..", "resources", "deno", filename);
  }

  /**
   * Gets the ~/.swamp/deno/ directory path for extracting the runtime.
   */
  private getSwampDenoDir(): string {
    const home = Deno.env.get("HOME") ??
      Deno.env.get("USERPROFILE");
    if (!home) {
      throw new Error(
        "Cannot determine home directory (HOME/USERPROFILE not set)",
      );
    }
    return join(home, ".swamp", "deno");
  }
}
