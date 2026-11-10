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

import { dirname, join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import { DenoVersion } from "../../domain/runtime/deno_version.ts";
import {
  type CommandResolver,
  defaultCommandResolver,
} from "../process/resolve_command.ts";
import { getSwampDataDir } from "../persistence/paths.ts";
import { removeAbandonedTempFiles } from "../persistence/abandoned_temp_files.ts";
import { resourcePath } from "./resource_root.ts";

const logger = getLogger(["swamp", "runtime", "deno"]);

const DENO_BINARY_NAME = Deno.build.os === "windows" ? "deno.exe" : "deno";

/**
 * macOS extended attributes are cleared after writing to prevent
 * provenance-based SIGKILL; a deno --version health check runs, and if it fails
 * after extraction swamp falls back to a system deno in PATH
 */
export class EmbeddedDenoRuntime implements DenoRuntime {
  private cachedPath: string | null = null;
  private extractionPromise: Promise<string> | null = null;
  private readonly commandResolver: CommandResolver;

  constructor(commandResolver: CommandResolver = defaultCommandResolver()) {
    this.commandResolver = commandResolver;
  }

  async ensureDeno(): Promise<string> {
    if (this.cachedPath) {
      return this.cachedPath;
    }

    // deno-lint-ignore no-explicit-any
    if (!(Deno.build as any).standalone) {
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

    const embeddedVersion = await this.readEmbeddedVersion();

    try {
      const existingVersion = (await Deno.readTextFile(versionMarker)).trim();
      if (existingVersion === embeddedVersion.value) {
        await Deno.stat(targetBinary);
        logger
          .debug`Deno ${embeddedVersion} already extracted at ${targetBinary}`;
        const check = await this.healthCheck(targetBinary);
        if (check.ok) {
          return targetBinary;
        }
        logger
          .warn`Extracted deno at ${targetBinary} failed health check — re-extracting: ${check.stderr}`;
      }
    } catch {
      // Version marker missing or binary missing — need to extract
    }

    logger.debug`Extracting embedded deno ${embeddedVersion} to ${swampDir}`;

    await Deno.mkdir(swampDir, { recursive: true });

    // Clean up temp files abandoned by a previous crashed extraction. Fresh
    // ones are kept — they may belong to a concurrent process mid-extraction.
    await removeAbandonedTempFiles(swampDir, ".deno.tmp.");

    const embeddedBinary = await this.readEmbeddedBinary();

    // Write to a temp file, set permissions, then atomic-rename into place.
    // Atomic rename creates a new inode — running processes keep their vnode
    // reference to the old inode (no ETXTBSY on Linux, no SIGKILL on macOS).
    const tmpPath = join(swampDir, `.deno.tmp.${crypto.randomUUID()}`);
    try {
      await Deno.writeFile(tmpPath, embeddedBinary);

      if (Deno.build.os !== "windows") {
        await Deno.chmod(tmpPath, 0o755);
      }

      await this.clearMacOSExtendedAttributes(tmpPath);
      await Deno.rename(tmpPath, targetBinary);
    } catch (error) {
      try {
        await Deno.remove(tmpPath);
      } catch {
        // Temp file may not exist if writeFile failed before creating it
      }
      throw error;
    }

    await Deno.writeTextFile(versionMarker, embeddedVersion.value);

    logger
      .debug`Extracted deno ${embeddedVersion} (${embeddedBinary.length} bytes)`;

    const postExtract = await this.healthCheck(targetBinary);
    if (postExtract.ok) {
      return targetBinary;
    }

    logger
      .warn`Embedded deno at ${targetBinary} failed health check after extraction — falling back to system deno: ${postExtract.stderr}`;
    const systemDeno = await this.findSystemDeno();
    if (systemDeno) {
      logger.warn`Using system deno at ${systemDeno}`;
      return systemDeno;
    }

    throw new Error(
      `Embedded deno at ${targetBinary} failed health check and no system deno found in PATH. ` +
        this.platformHint(targetBinary) +
        (postExtract.stderr ? ` Detail: ${postExtract.stderr}` : ""),
    );
  }

  /**
   * explicit cwd so the child does not inherit an inaccessible working
   * directory, e.g. via sudo -u from another user's restricted home
   */
  private async healthCheck(
    binaryPath: string,
  ): Promise<{ ok: boolean; stderr: string }> {
    try {
      const result = await new Deno.Command(binaryPath, {
        args: ["--version"],
        stdout: "null",
        stderr: "piped",
        cwd: dirname(binaryPath),
        env: this.getDenoEnv(),
      }).output();
      const stderr = new TextDecoder().decode(result.stderr).trim()
        .slice(0, 500);
      return { ok: result.success, stderr };
    } catch (e) {
      return { ok: false, stderr: String(e).slice(0, 500) };
    }
  }

  /**
   * writing via Deno.writeFile records provenance in com.apple.provenance,
   * which can make macOS SIGKILL the binary when spawned; clearing attributes
   * after writing prevents it
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
        cwd: dirname(binaryPath),
      }).output();
      logger.debug`Cleared macOS extended attributes on ${binaryPath}`;
    } catch {
      // xattr not available — best effort, health check will catch failures
    }
  }

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

  private getEmbeddedResourcePath(filename: string): string {
    return resourcePath("resources", "deno", filename);
  }

  private getSwampDenoDir(): string {
    return join(getSwampDataDir(), "deno");
  }

  private platformHint(binaryPath: string): string {
    if (Deno.build.os === "darwin") {
      return `Try: xattr -c ${binaryPath}`;
    }
    if (Deno.build.os === "linux") {
      return (
        `Ensure the working directory is accessible to the running user, ` +
        `or set SWAMP_HOME to a writable location.`
      );
    }
    return `Check file permissions on ${binaryPath}`;
  }

  /**
   * DENO_DIR is scoped to the swamp data directory so the embedded deno does
   * not create $HOME/Library/Caches/deno on macOS, which traverses $HOME and
   * triggers TCC prompts
   */
  getDenoEnv(): Record<string, string> {
    return {
      ...Deno.env.toObject(),
      DENO_DIR: join(getSwampDataDir(), "deno-cache"),
    };
  }
}
