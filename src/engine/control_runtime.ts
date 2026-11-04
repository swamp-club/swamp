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

import type { WorkspaceRegistryRepository } from "../domain/workspace/workspace_registry.ts";
import { parseWorkspaceName } from "../domain/workspace/workspace_name.ts";
import {
  ENGINE_PROTOCOL,
  type EngineRequest,
  EngineWriter,
  parseEngineRequest,
} from "./protocol.ts";

export interface HubWorkspace {
  readonly name: string;
  readonly path: string;
  readonly trusted: boolean;
}

export interface ControlRuntimeOptions {
  readonly workspaces: WorkspaceRegistryRepository;
  isRepo(path: string): Promise<boolean>;
  realPath(path: string): Promise<string>;
  readonly engineVersion: string;
  readonly gitSha: string;
}

class ControlFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const UNKNOWN_WORKSPACE = new ControlFailure(
  "unknown_workspace",
  "No registered workspace by that name",
);

/**
 * The hub's repository-less engine: Go asks it for workspace facts because Go
 * never reads swamp persistence. It holds no repository and runs no commands.
 */
export class ControlRuntime {
  readonly #options: ControlRuntimeOptions;
  readonly #writer: EngineWriter;
  #generation: string | undefined;
  #state: "starting" | "ready" | "stopped" = "starting";

  constructor(
    options: ControlRuntimeOptions,
    output: WritableStream<Uint8Array>,
  ) {
    this.#options = options;
    this.#writer = new EngineWriter(output);
  }

  async serve(frames: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const frame of frames) {
        const request = parseEngineRequest(frame);
        if (this.#generation === undefined) {
          if (
            request.method !== "hello" ||
            request.params?.profile !== ENGINE_PROTOCOL.hubControl.profile
          ) {
            throw new Error("Hub control hello required");
          }
          this.#generation = request.generation;
        }
        if (request.generation !== this.#generation) {
          throw new Error("Engine generation mismatch");
        }
        await this.#respond(request);
        await this.#writer.flush();
        if (this.#state === "stopped") break;
      }
    } finally {
      this.#state = "stopped";
      await this.#writer.close();
    }
  }

  async #respond(request: EngineRequest): Promise<void> {
    const base = {
      version: ENGINE_PROTOCOL.version,
      generation: this.#generation,
      id: request.id,
    };
    try {
      this.#writer.send({ ...base, result: await this.#dispatch(request) });
    } catch (error) {
      // Registry and filesystem errors can carry paths; only authored codes cross.
      const failure = error instanceof ControlFailure
        ? error
        : new ControlFailure("engine_error", "Hub control failed");
      this.#writer.send({
        ...base,
        error: { code: failure.code, message: failure.message },
      });
    }
  }

  async #dispatch(request: EngineRequest): Promise<unknown> {
    const params = request.params ?? {};
    switch (request.method) {
      case "hello":
        if (this.#state !== "starting") {
          throw new ControlFailure(
            "invalid_state",
            "Engine already initialized",
          );
        }
        this.#state = "ready";
        return {
          version: ENGINE_PROTOCOL.version,
          profile: ENGINE_PROTOCOL.hubControl.profile,
          controls: ENGINE_PROTOCOL.hubControl.controls,
          engineVersion: this.#options.engineVersion,
          gitSha: this.#options.gitSha,
        };
      case "workspace.resolve":
        return await this.#resolve(params.name);
      case "workspace.list":
        return { workspaces: await this.#list() };
      case "engine.status":
        return {
          state: this.#state,
          sessions: 0,
          requests: 0,
          runs: 0,
          reservations: 0,
          pendingWrites: this.#writer.pending,
          authenticationWork: 0,
        };
      case "engine.quiesce":
      case "engine.shutdown":
        // Each control completes before the next is read, so nothing is in flight.
        this.#state = "stopped";
        return request.method === "engine.quiesce" ? { quiescent: true } : {};
      default:
        throw new ControlFailure(
          "unsupported_operation",
          "Unknown hub control operation",
        );
    }
  }

  async #resolve(name: unknown): Promise<HubWorkspace> {
    if (typeof name !== "string") throw UNKNOWN_WORKSPACE;
    try {
      parseWorkspaceName(name);
    } catch {
      throw UNKNOWN_WORKSPACE;
    }
    const registry = await this.#options.workspaces.load();
    const entry = registry?.get(name);
    // A registered folder that is gone or no longer a repository is not served.
    if (!entry || !await this.#options.isRepo(entry.path)) {
      throw UNKNOWN_WORKSPACE;
    }
    return {
      name: entry.name,
      // The engine reports the realpath it bound; Go compares the two.
      path: await this.#options.realPath(entry.path),
      trusted: registry!.isTrusted(entry.path),
    };
  }

  async #list(): Promise<HubWorkspace[]> {
    const registry = await this.#options.workspaces.load();
    return (registry?.list() ?? []).map((entry) => ({
      name: entry.name,
      path: entry.path,
      trusted: registry!.isTrusted(entry.path),
    }));
  }
}
