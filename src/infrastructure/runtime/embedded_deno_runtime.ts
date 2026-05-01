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
import {
  type CommandResolver,
  defaultCommandResolver,
} from "../process/resolve_command.ts";

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
 *
 * After extraction (and on each startup when the version is already current),
 * a health check runs `deno --version` to verify the binary executes cleanly.
 * On macOS, extended attributes are cleared after writing to prevent
 * provenance-based SIGKILL from the OS security layer. If the health check
 * still fails after extraction, swamp falls back to a system `deno` in PATH.
 */
export class EmbeddedDenoRuntime implements DenoRuntime {
  private cachedPath: string | null = null;
  private extractionPromise: Promise<string> | null = null;
  private readonly commandResolver: CommandResolver;

  /**
   * @param commandResolver Override the system PATH resolver. Tests inject a
   *   fake to exercise the standalone-mode fallback path without depending on
   *   the host's installed `deno`.
   */
  constructor(commandResolver: CommandResolver = defaultCommandResolver()) {
    this.commandResolver = commandResolver;
  }

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

    // Standalone mode: extract embedded binary.
    // Share a single extraction promise so concurrent callers (e.g. parallel
    // extension loaders) don't each spawn their own redundant extraction.
    if (!this.extractionPromise) {
      this.extractionPromise = this.extractEmbeddedDeno();
    }
    this.cachedPath = await this.extractionPromise;
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
        await Deno.stat(targetBinary);
        logger
          .debug`Deno ${embeddedVersion} already extracted at ${targetBinary}`;
        if (await this.healthCheck(targetBinary)) {
          return targetBinary;
        }
        logger
          .warn`Extracted deno at ${targetBinary} failed health check — re-extracting`;
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

    // On macOS, clear extended attributes after writing so the OS doesn't
    // apply provenance-based security restrictions (SIGKILL) to the binary.
    await this.clearMacOSExtendedAttributes(targetBinary);

    // Write version marker
    await Deno.writeTextFile(versionMarker, embeddedVersion.value);

    logger
      .info`Extracted deno ${embeddedVersion} (${embeddedBinary.length} bytes)`;

    if (await this.healthCheck(targetBinary)) {
      return targetBinary;
    }

    // Extracted binary still unhealthy — fall back to system deno in PATH.
    logger
      .warn`Embedded deno at ${targetBinary} failed health check after extraction — falling back to system deno`;
    const systemDeno = await this.findSystemDeno();
    if (systemDeno) {
      logger.warn`Using system deno at ${systemDeno}`;
      return systemDeno;
    }

    throw new Error(
      `Embedded deno at ${targetBinary} failed health check and no system deno found in PATH. ` +
        `Try: xattr -c ${targetBinary}`,
    );
  }

  /**
   * Returns true if the binary at the given path executes cleanly.
   */
  private async healthCheck(binaryPath: string): Promise<boolean> {
    try {
      const result = await new Deno.Command(binaryPath, {
        args: ["--version"],
        stdout: "null",
        stderr: "null",
      }).output();
      return result.success;
    } catch {
      return false;
    }
  }

  /**
   * Clears all extended attributes on a file on macOS.
   *
   * When swamp writes the embedded deno binary via Deno.writeFile, macOS
   * records the writing process's provenance in com.apple.provenance. This
   * can cause the OS security layer to SIGKILL the binary when it is later
   * spawned as a subprocess. Clearing attributes after writing prevents this.
   */
  private async clearMacOSExtendedAttributes(
    binaryPath: string,
  ): Promise<void> {
    if (Deno.build.os !== "darwin") return;
    try {
      await new Deno.Command("xattr", {
        args: ["-c", binaryPath],
        stdout: "null",
        stderr: "null",
      }).output();
      logger.debug`Cleared macOS extended attributes on ${binaryPath}`;
    } catch {
      // xattr not available — best effort, health check will catch failures
    }
  }

  /**
   * Searches PATH for a system-installed deno binary.
   * Used as a fallback when the embedded binary fails its health check.
   *
   * The multi-line `which`/`where` parsing semantics live in
   * `CommandResolver` and are covered by `resolve_command_test.ts`. The
   * `commandResolver` constructor argument is the injection seam if tests
   * ever need to drive this path through a public method (currently
   * `ensureDeno()` only invokes it when `Deno.build.standalone === true`,
   * which is not flippable from a test).
   */
  private findSystemDeno(): Promise<string | null> {
    return this.commandResolver.resolve("deno");
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
