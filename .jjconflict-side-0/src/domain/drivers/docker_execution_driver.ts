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

import { z } from "zod";
import type {
  DriverOutput,
  ExecutionCallbacks,
  ExecutionDriver,
  ExecutionRequest,
  ExecutionResult,
} from "./execution_driver.ts";
import { streamLines } from "../../infrastructure/process/process_executor.ts";
import { DOCKER_RUNNER_SCRIPT } from "./docker_runner.ts";

/** Grace period (ms) before sending SIGKILL after SIGTERM on timeout. */
const SIGKILL_GRACE_MS = 5_000;

/**
 * Zod schema for Docker driver configuration.
 */
export const DockerDriverConfigSchema = z.object({
  /** Docker image to run (required). */
  image: z.string().min(1, "Docker image is required"),
  /** Image to use for bundle mode (default: same as `image`). Must have Deno installed. */
  bundleImage: z.string().optional(),
  /** CLI binary — supports docker, podman, nerdctl. */
  command: z.string().default("docker"),
  /** Timeout in milliseconds. */
  timeout: z.number().positive().optional(),
  /** Docker network to attach. */
  network: z.string().optional(),
  /** Memory limit (e.g. "512m"). */
  memory: z.string().optional(),
  /** CPU limit (e.g. "1.5"). */
  cpus: z.string().optional(),
  /** Volume mounts (e.g. ["/host:/container"]). */
  volumes: z.array(z.string()).optional(),
  /** Environment variables to pass into the container. */
  env: z.record(z.string(), z.string()).optional(),
  /** Additional docker run flags appended before the image. */
  extraArgs: z.array(z.string()).optional(),
});

/**
 * Inferred TypeScript type for Docker driver configuration.
 */
export type DockerDriverConfig = z.infer<typeof DockerDriverConfigSchema>;

/**
 * Docker execution driver — runs model methods in isolated Docker containers.
 *
 * Supports two modes:
 * - **Command mode**: runs a shell command from `methodArgs.run`. Stdout becomes
 *   resource data, stderr streams as real-time logs.
 * - **Bundle mode**: runs a pre-compiled TypeScript bundle inside a Deno container.
 *   The bundle is mounted alongside a runner script that captures writeResource /
 *   createFileWriter calls and outputs JSON to stdout.
 */
export class DockerExecutionDriver implements ExecutionDriver {
  readonly type = "docker";
  private readonly config: DockerDriverConfig;

  constructor(config: Record<string, unknown>) {
    this.config = DockerDriverConfigSchema.parse(config);
  }

  execute(
    request: ExecutionRequest,
    callbacks?: ExecutionCallbacks,
  ): Promise<ExecutionResult> {
    const hasBundle = request.bundle !== undefined && request.bundle.length > 0;
    const hasRunCommand = typeof request.methodArgs.run === "string" &&
      (request.methodArgs.run as string).trim() !== "";

    if (hasBundle) {
      return this.executeBundle(request, callbacks);
    } else if (hasRunCommand) {
      return this.executeCommand(request, callbacks);
    } else {
      return Promise.resolve({
        status: "error" as const,
        error:
          "Docker driver requires either a bundle or a 'run' string in methodArgs",
        outputs: [],
        logs: [],
        durationMs: 0,
      });
    }
  }

  /**
   * Command mode: runs a shell command inside the container.
   * Stdout becomes resource data, stderr streams as real-time logs.
   */
  private async executeCommand(
    request: ExecutionRequest,
    callbacks?: ExecutionCallbacks,
  ): Promise<ExecutionResult> {
    const start = performance.now();
    const logs: string[] = [];
    let killTimeoutId: number | undefined;

    const run = request.methodArgs.run as string;
    const containerName = `swamp-${crypto.randomUUID().slice(0, 8)}`;
    const args = this.buildCommandArgs(containerName, run);

    try {
      const command = new Deno.Command(this.config.command, {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      });

      const process = command.spawn();
      let timedOut = false;
      let timeoutId: number | undefined;

      if (this.config.timeout) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          try {
            process.kill("SIGTERM");
          } catch {
            // Process may have already exited
          }
          // Force-kill after 5s grace period if SIGTERM is ignored
          killTimeoutId = setTimeout(() => {
            try {
              process.kill("SIGKILL");
            } catch {
              // Process may have already exited
            }
          }, SIGKILL_GRACE_MS);
        }, this.config.timeout);
      }

      try {
        const [stdoutResult, stderrResult, status] = await Promise.all([
          streamLines(process.stdout),
          streamLines(process.stderr, (line) => {
            logs.push(line);
            callbacks?.onLog?.(line);
          }),
          process.status,
        ]);

        const durationMs = performance.now() - start;

        if (timedOut) {
          return {
            status: "error",
            error: `Docker command timed out after ${this.config.timeout}ms`,
            outputs: [],
            logs,
            durationMs,
          };
        }

        if (status.code !== 0) {
          return {
            status: "error",
            error: stderrResult ||
              `Container exited with code ${status.code}`,
            outputs: [],
            logs,
            durationMs,
          };
        }

        // Success: return raw stdout as content with execution metadata.
        const resourceSpecNames = request.resourceSpecs
          ? Object.keys(request.resourceSpecs)
          : [];
        const fileSpecNames = request.fileSpecs
          ? Object.keys(request.fileSpecs)
          : [];
        const specName = resourceSpecNames[0] ?? request.methodName;
        const content = new TextEncoder().encode(stdoutResult);

        const outputs: DriverOutput[] = [{
          kind: "pending",
          specName,
          name: specName,
          type: "resource",
          content,
          metadata: {
            exitCode: status.code,
            command: request.methodArgs.run as string,
            durationMs: Math.round(durationMs),
            stderr: stderrResult,
          },
        }];

        // Produce a file output for logs if a file spec is declared
        if (fileSpecNames.length > 0) {
          const logParts: string[] = [];
          if (stdoutResult) {
            logParts.push(`[stdout]\n${stdoutResult}`);
          }
          if (stderrResult) {
            logParts.push(`[stderr]\n${stderrResult}`);
          }
          const logContent = new TextEncoder().encode(logParts.join("\n"));
          outputs.push({
            kind: "pending",
            specName: fileSpecNames[0],
            name: fileSpecNames[0],
            type: "file",
            content: logContent,
          });
        }

        return {
          status: "success",
          outputs,
          logs,
          durationMs,
        };
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        if (killTimeoutId !== undefined) {
          clearTimeout(killTimeoutId);
        }
      }
    } catch (error) {
      const durationMs = performance.now() - start;
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        outputs: [],
        logs,
        durationMs,
      };
    }
  }

  /**
   * Bundle mode: runs a pre-compiled TypeScript bundle inside a Deno container.
   * Mounts the bundle, request JSON, and runner script into `/swamp/`.
   */
  private async executeBundle(
    request: ExecutionRequest,
    callbacks?: ExecutionCallbacks,
  ): Promise<ExecutionResult> {
    const start = performance.now();
    const logs: string[] = [];
    let tempDir: string | undefined;
    let killTimeoutId: number | undefined;

    try {
      // Create temp dir with bundle files
      tempDir = await Deno.makeTempDir({ prefix: "swamp-docker-" });

      const bundleSource = new TextDecoder().decode(request.bundle!);
      await Deno.writeTextFile(`${tempDir}/bundle.js`, bundleSource);

      const requestPayload = {
        methodName: request.methodName,
        methodArgs: request.methodArgs,
        globalArgs: request.globalArgs,
        modelType: request.modelType,
        modelId: request.modelId,
        definitionMeta: request.definitionMeta,
      };
      await Deno.writeTextFile(
        `${tempDir}/request.json`,
        JSON.stringify(requestPayload),
      );

      await Deno.writeTextFile(`${tempDir}/runner.js`, DOCKER_RUNNER_SCRIPT);

      // Build docker args for bundle mode
      const containerName = `swamp-${crypto.randomUUID().slice(0, 8)}`;
      const args = this.buildBundleArgs(containerName, tempDir);

      const command = new Deno.Command(this.config.command, {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      });

      const process = command.spawn();
      let timedOut = false;
      let timeoutId: number | undefined;

      if (this.config.timeout) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          try {
            process.kill("SIGTERM");
          } catch {
            // Process may have already exited
          }
          // Force-kill after 5s grace period if SIGTERM is ignored
          killTimeoutId = setTimeout(() => {
            try {
              process.kill("SIGKILL");
            } catch {
              // Process may have already exited
            }
          }, SIGKILL_GRACE_MS);
        }, this.config.timeout);
      }

      try {
        const [stdoutResult, stderrResult, status] = await Promise.all([
          streamLines(process.stdout),
          streamLines(process.stderr, (line) => {
            logs.push(line);
            callbacks?.onLog?.(line);
          }),
          process.status,
        ]);

        const durationMs = performance.now() - start;

        if (timedOut) {
          return {
            status: "error",
            error:
              `Docker bundle execution timed out after ${this.config.timeout}ms`,
            outputs: [],
            logs,
            durationMs,
          };
        }

        if (status.code !== 0) {
          return {
            status: "error",
            error: stderrResult ||
              `Bundle container exited with code ${status.code}`,
            outputs: [],
            logs,
            durationMs,
          };
        }

        // Parse the runner's JSON output
        const outputs = this.parseBundleOutput(stdoutResult, durationMs);

        return {
          status: "success",
          outputs,
          logs,
          durationMs,
        };
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        if (killTimeoutId !== undefined) {
          clearTimeout(killTimeoutId);
        }
      }
    } catch (error) {
      const durationMs = performance.now() - start;
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        outputs: [],
        logs,
        durationMs,
      };
    } finally {
      // Clean up temp dir
      if (tempDir) {
        try {
          await Deno.remove(tempDir, { recursive: true });
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }

  /**
   * Parses the JSON output from the Docker runner script into DriverOutput[].
   */
  private parseBundleOutput(
    stdout: string,
    durationMs: number,
  ): DriverOutput[] {
    const encoder = new TextEncoder();
    const outputs: DriverOutput[] = [];

    let parsed: { resources?: unknown[]; files?: unknown[] };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // If stdout isn't valid JSON, return it as a raw resource output
      return [{
        kind: "pending",
        specName: "output",
        name: "output",
        type: "resource",
        content: encoder.encode(stdout),
        metadata: { durationMs: Math.round(durationMs) },
      }];
    }

    // Convert resources to pending outputs
    if (Array.isArray(parsed.resources)) {
      for (const res of parsed.resources as Array<Record<string, unknown>>) {
        if (
          typeof res?.specName !== "string" || typeof res?.name !== "string"
        ) {
          continue; // Skip malformed entries
        }
        outputs.push({
          kind: "pending",
          specName: res.specName,
          name: res.name,
          type: "resource",
          content: encoder.encode(JSON.stringify(res.data ?? {})),
        });
      }
    }

    // Convert files to pending outputs (base64 decode)
    if (Array.isArray(parsed.files)) {
      for (const file of parsed.files as Array<Record<string, unknown>>) {
        if (
          typeof file?.specName !== "string" ||
          typeof file?.name !== "string" ||
          typeof file?.content !== "string"
        ) {
          continue; // Skip malformed entries
        }
        let decoded: Uint8Array;
        try {
          decoded = Uint8Array.from(
            atob(file.content),
            (c) => c.charCodeAt(0),
          );
        } catch {
          continue; // Skip entries with invalid base64
        }
        outputs.push({
          kind: "pending",
          specName: file.specName,
          name: file.name,
          type: "file",
          content: decoded,
        });
      }
    }

    return outputs;
  }

  /**
   * Builds the docker run argument array for command mode.
   */
  buildCommandArgs(containerName: string, commandString: string): string[] {
    const args = this.buildCommonArgs(containerName);
    args.push(this.config.image);
    args.push("sh", "-c", commandString);
    return args;
  }

  /**
   * Builds the docker run argument array for bundle mode.
   */
  buildBundleArgs(containerName: string, tempDir: string): string[] {
    const args = this.buildCommonArgs(containerName);

    // Mount the workspace with bundle, request, and runner
    args.push("-v", `${tempDir}:/swamp:ro`);

    // Use bundleImage if configured, otherwise fall back to image
    const image = this.config.bundleImage ?? this.config.image;
    args.push(image);
    args.push("deno", "run", "--allow-all", "/swamp/runner.js");
    return args;
  }

  /**
   * Builds the common docker run arguments shared by both modes.
   */
  private buildCommonArgs(containerName: string): string[] {
    const args: string[] = ["run", "--rm", "--name", containerName];

    if (this.config.network) {
      args.push("--network", this.config.network);
    }
    if (this.config.memory) {
      args.push("--memory", this.config.memory);
    }
    if (this.config.cpus) {
      args.push("--cpus", this.config.cpus);
    }
    if (this.config.volumes) {
      for (const volume of this.config.volumes) {
        args.push("-v", volume);
      }
    }
    if (this.config.env) {
      for (const [key, value] of Object.entries(this.config.env)) {
        args.push("-e", `${key}=${value}`);
      }
    }
    if (this.config.extraArgs) {
      args.push(...this.config.extraArgs);
    }

    return args;
  }

  /**
   * Builds the docker run argument array from config and the command to run.
   * @deprecated Use buildCommandArgs or buildBundleArgs instead.
   */
  buildDockerArgs(containerName: string, commandString: string): string[] {
    return this.buildCommandArgs(containerName, commandString);
  }
}
