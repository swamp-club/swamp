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
import type { DashboardAsset } from "../serve/dashboard_assets.ts";
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

/** a running `swamp serve`, as its instance record in the repo describes it */
export interface HubServeInstance {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly authMode: string;
  readonly dashboard: boolean;
  readonly startedAt: string;
  readonly version: string;
}

export interface ControlRuntimeOptions {
  readonly workspaces: WorkspaceRegistryRepository;
  /** the live `swamp serve` processes that recorded themselves in a repo */
  listServes(repoPath: string): Promise<readonly HubServeInstance[]>;
  /** the port the repo's serve config sets, if it sets one */
  configuredServePort(repoPath: string): Promise<number | undefined>;
  isRepo(path: string): Promise<boolean>;
  realPath(path: string): Promise<string>;
  /** the file answering `/dashboard/<subPath>`, SPA fallback included */
  locateAsset(subPath: string): Promise<DashboardAsset | "forbidden" | null>;
  readAsset(
    file: string,
    offset: number,
    length: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly size: number }>;
  readonly engineVersion: string;
  readonly gitSha: string;
  readonly now?: () => Date;
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

const NOT_A_REPO = new ControlFailure(
  "not_a_repo",
  "That folder is not a swamp repository",
);

const UNKNOWN_ASSET = new ControlFailure(
  "unknown_asset",
  "No dashboard asset at that path",
);

/** keeps a workspace.serves reply well under the control reply limit */
const MAX_SERVE_PATHS = 64;

/** base64 of a chunk stays under the 64 KiB control reply limit */
export const ASSET_CHUNK_BYTES = 32 * 1024;

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
      case "workspace.inspect":
        return await this.#inspect(params.path);
      case "workspace.trust":
        return await this.#trust(params.name);
      case "workspace.serves":
        return { workspaces: await this.#serves(params.paths) };
      case "workspace.serveConfig":
        return await this.#serveConfig(params.name);
      case "asset.get":
        return await this.#asset(params.path, params.offset);
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

  /**
   * records the user's trust in a registered workspace, as the start page's
   * trust confirmation does; the hub asks only for a manage lease's page
   */
  async #trust(name: unknown): Promise<HubWorkspace> {
    const workspace = await this.#resolve(name);
    const at = (this.#options.now?.() ?? new Date()).toISOString();
    await this.#options.workspaces.update((registry) => {
      const entry = registry.get(workspace.name);
      if (!entry) throw UNKNOWN_WORKSPACE;
      registry.markTrusted(entry.path, at);
    });
    return { ...workspace, trusted: true };
  }

  async #serves(
    paths: unknown,
  ): Promise<
    { path: string; serves: readonly HubServeInstance[] }[]
  > {
    if (
      !Array.isArray(paths) || paths.length > MAX_SERVE_PATHS ||
      !paths.every((path) => typeof path === "string" && path !== "")
    ) {
      throw new ControlFailure("invalid_params", "paths must be folder paths");
    }
    const found = [];
    for (const path of paths as string[]) {
      let real: string;
      try {
        real = await this.#options.realPath(path);
      } catch {
        continue;
      }
      if (!await this.#options.isRepo(real)) continue;
      found.push({ path, serves: await this.#options.listServes(real) });
    }
    return found;
  }

  /** what the hub needs to start a registered workspace's `swamp serve` */
  async #serveConfig(
    name: unknown,
  ): Promise<HubWorkspace & { readonly port?: number }> {
    const workspace = await this.#resolve(name);
    let port: number | undefined;
    try {
      port = await this.#options.configuredServePort(workspace.path);
    } catch {
      // An unreadable serve config is serve's to report when it starts.
    }
    return port === undefined ? workspace : { ...workspace, port };
  }

  /** what the start page lists: registered folders that are still repos */
  async #list(): Promise<HubWorkspace[]> {
    const registry = await this.#options.workspaces.load();
    const entries = registry?.list() ?? [];
    const repos = await Promise.all(
      entries.map((entry) => this.#options.isRepo(entry.path)),
    );
    return entries.filter((_, i) => repos[i]).map((entry) => ({
      name: entry.name,
      path: entry.path,
      trusted: registry!.isTrusted(entry.path),
    }));
  }

  async #inspect(path: unknown): Promise<{ path: string }> {
    if (typeof path !== "string" || path === "") throw NOT_A_REPO;
    let real: string;
    try {
      real = await this.#options.realPath(path);
    } catch {
      throw NOT_A_REPO;
    }
    if (!await this.#options.isRepo(real)) throw NOT_A_REPO;
    return { path: real };
  }

  async #asset(path: unknown, offset: unknown): Promise<unknown> {
    if (
      typeof path !== "string" ||
      typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
    ) {
      throw new ControlFailure("invalid_request", "Invalid asset request");
    }
    const asset = await this.#options.locateAsset(path);
    if (asset === "forbidden") throw UNKNOWN_ASSET;
    if (asset === null) {
      throw new ControlFailure(
        "assets_unavailable",
        "Dashboard assets not available in this build",
      );
    }
    let chunk: { bytes: Uint8Array; size: number };
    try {
      chunk = await this.#options.readAsset(
        asset.file,
        offset,
        ASSET_CHUNK_BYTES,
      );
    } catch {
      throw UNKNOWN_ASSET;
    }
    return {
      contentType: asset.contentType,
      cacheControl: asset.cacheControl,
      size: chunk.size,
      offset,
      data: toBase64(chunk.bytes),
      done: offset + chunk.bytes.length >= chunk.size,
    };
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
