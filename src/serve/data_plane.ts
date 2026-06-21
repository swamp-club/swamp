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

/**
 * The remote-execution HTTP data plane (see design/remote-execution.md,
 * "Data plane: two transports").
 *
 * Byte-heavy operations only — artifact reads, writes, appends, bundle and
 * asset fetches. Served from the same listener as the control socket; over
 * TLS Deno negotiates HTTP/2 via ALPN, over plain TCP the identical handlers
 * run on HTTP/1.1. Every route is bearer-authenticated with the worker's
 * session credential, and every write is authorized against the worker's
 * active dispatch: persistence flows through the same data writers a local
 * run uses, so declared-spec enforcement comes for free.
 *
 * Routes:
 *   GET  /data/{type}/{modelId}/{dataName}/{version}   read artifact bytes
 *   POST /data/resource                                write a resource (JSON)
 *   POST /data/writers                                 open a file writer
 *   POST /data/writers/{id}/line                       durable line append
 *   POST /data/writers/{id}/content                    stream bytes + finalize
 *   POST /data/writers/{id}/finalize                   finalize a line writer
 *   GET  /bundle/{fingerprint}                         fetch extension bundle
 *   GET  /bundle/{fingerprint}/file/{relPath}          fetch co-located asset
 */

import { isAbsolute, join, normalize, resolve } from "@std/path";
import { ModelType } from "../domain/models/model_type.ts";
import type { DataHandle, DataWriter } from "../domain/models/model.ts";
import {
  createFileWriterFactory,
  createResourceWriter,
} from "../domain/models/data_writer.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { VaultService } from "../domain/vaults/vault_service.ts";
import type { ActiveDispatch, DispatchRegistry } from "./dispatch_registry.ts";
import type { BundleRegistry } from "./bundle_registry.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "data-plane"]);

export interface DataPlaneOptions {
  repoDir: string;
  repoContext: RepositoryContext;
  sessions: { verify(credential: string): string | null };
  dispatches: DispatchRegistry;
  bundles: BundleRegistry;
  /** Fired on a dispatch's first durable write (drives lease.mark_writes). */
  onFirstWrite?: (dispatch: ActiveDispatch) => Promise<void>;
  /** Overridable for tests; defaults to VaultService.fromRepository. */
  createVaultService?: () => Promise<VaultService>;
}

interface WriterSession {
  writer: DataWriter;
  workerName: string;
  dispatchId: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

class DataPlaneError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DataPlaneError";
    this.status = status;
  }
}

function handleToJson(handle: DataHandle): Record<string, unknown> {
  return {
    dataId: handle.dataId,
    name: handle.name,
    specName: handle.specName,
    kind: handle.kind,
    version: handle.version,
    size: handle.size,
    tags: handle.tags,
  };
}

/**
 * The data plane handler. `handle()` returns null for requests outside its
 * routes so the caller can fall through to other endpoints on the listener.
 */
export class DataPlane {
  readonly #options: DataPlaneOptions;
  readonly #writers = new Map<string, WriterSession>();
  readonly #dispatchesWithWrites = new Set<string>();
  #vaultService: Promise<VaultService> | null = null;

  constructor(options: DataPlaneOptions) {
    this.#options = options;
  }

  /** Number of open writer sessions (test introspection). */
  get openWriterCount(): number {
    return this.#writers.size;
  }

  /**
   * Drop all writer sessions for a finished or failed dispatch. Called by
   * the dispatcher when a dispatch ends, so an abandoned line-writer cannot
   * leak across dispatches.
   */
  releaseDispatch(dispatchId: string): void {
    for (const [id, session] of [...this.#writers.entries()]) {
      if (session.dispatchId === dispatchId) {
        this.#writers.delete(id);
      }
    }
    this.#dispatchesWithWrites.delete(dispatchId);
  }

  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) {
      return null;
    }
    const [root] = segments;
    if (root !== "data" && root !== "bundle") {
      return null;
    }

    const workerName = this.#authenticate(req);
    if (workerName === null) {
      return errorResponse(401, "Missing or invalid session credential");
    }

    try {
      if (root === "bundle") {
        return this.#handleBundle(req, segments);
      }
      return await this.#handleData(req, segments, workerName);
    } catch (error) {
      if (error instanceof DataPlaneError) {
        return errorResponse(error.status, error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Data-plane request failed: {method} {path}: {error}", {
        method: req.method,
        path: url.pathname,
        error: message,
      });
      return errorResponse(500, "Internal server error");
    }
  }

  #authenticate(req: Request): string | null {
    const header = req.headers.get("authorization");
    if (header === null || !header.startsWith("Bearer ")) {
      return null;
    }
    return this.#options.sessions.verify(header.slice("Bearer ".length));
  }

  #activeDispatch(workerName: string): ActiveDispatch {
    const dispatch = this.#options.dispatches.forWorker(workerName);
    if (dispatch === null) {
      throw new DataPlaneError(
        400,
        `Worker '${workerName}' has no active dispatch — writes are lease-scoped`,
      );
    }
    return dispatch;
  }

  async #recordWrite(dispatch: ActiveDispatch): Promise<void> {
    if (this.#dispatchesWithWrites.has(dispatch.dispatchId)) {
      return;
    }
    this.#dispatchesWithWrites.add(dispatch.dispatchId);
    await this.#options.onFirstWrite?.(dispatch);
  }

  #vault(): Promise<VaultService> {
    this.#vaultService ??= (this.#options.createVaultService ??
      (() => VaultService.fromRepository(this.#options.repoDir)))().catch(
        (error) => {
          this.#vaultService = null;
          throw error;
        },
      );
    return this.#vaultService;
  }

  // ── /data routes ───────────────────────────────────────────────────────

  async #handleData(
    req: Request,
    segments: string[],
    workerName: string,
  ): Promise<Response> {
    if (req.method === "GET" && segments.length === 5) {
      return await this.#readArtifact(req, segments);
    }
    if (req.method === "POST" && segments[1] === "resource") {
      return await this.#writeResource(req, workerName);
    }
    if (req.method === "POST" && segments[1] === "writers") {
      if (segments.length === 2) {
        return await this.#openWriter(req, workerName);
      }
      if (segments.length === 4) {
        return await this.#writerAction(
          req,
          segments[2],
          segments[3],
          workerName,
        );
      }
    }
    return errorResponse(404, "Unknown data-plane route");
  }

  async #readArtifact(req: Request, segments: string[]): Promise<Response> {
    const [, rawType, rawModelId, rawDataName, rawVersion] = segments;
    const type = ModelType.create(decodeURIComponent(rawType));
    const modelId = decodeURIComponent(rawModelId);
    const dataName = decodeURIComponent(rawDataName);
    const version = Number(rawVersion);
    if (!Number.isInteger(version) || version < 1) {
      return errorResponse(400, `Invalid version '${rawVersion}'`);
    }

    const data = await this.#options.repoContext.unifiedDataRepo.findByName(
      type,
      modelId,
      dataName,
      version,
    );
    if (data === null) {
      return errorResponse(404, `No data '${dataName}' version ${version}`);
    }

    // A (dataId, version) pair is immutable forever — a strong ETag lets the
    // worker (and any intermediary) cache it unconditionally.
    const etag = `"${data.id}-v${data.version}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    const stream = this.#options.repoContext.unifiedDataRepo.stream(
      type,
      modelId,
      dataName,
      version,
    );
    const headers = new Headers({
      "content-type": data.contentType,
      etag,
      "cache-control": "immutable, max-age=31536000",
    });
    if (data.size !== undefined) {
      headers.set("content-length", String(data.size));
    }
    return new Response(ReadableStream.from(stream), { headers });
  }

  async #writeResource(req: Request, workerName: string): Promise<Response> {
    const dispatch = this.#activeDispatch(workerName);
    const body = await req.json() as {
      specName?: string;
      name?: string;
      data?: Record<string, unknown>;
    };
    if (!body.specName || !body.name || body.data === undefined) {
      return errorResponse(400, "Expected { specName, name, data }");
    }

    const { writeResource } = createResourceWriter(
      this.#options.repoContext.unifiedDataRepo,
      dispatch.modelType,
      dispatch.modelId,
      dispatch.modelDef.resources ?? {},
      undefined, // tagOverrides
      undefined, // dataOutputOverrides
      dispatch.definitionTags,
      dispatch.runtimeTags,
      dispatch.definitionName,
      await this.#vault(),
      dispatch.methodName,
      undefined, // onEvent
      undefined, // redactor
    );
    // Mark the lease BEFORE persisting: a lease may over-report writes
    // (safe, conservative) but must never under-report them.
    await this.#recordWrite(dispatch);
    let handle: DataHandle;
    try {
      handle = await writeResource(body.specName, body.name, body.data);
    } catch (error) {
      throw new DataPlaneError(
        400,
        error instanceof Error ? error.message : String(error),
      );
    }
    return json(handleToJson(handle));
  }

  async #openWriter(req: Request, workerName: string): Promise<Response> {
    const dispatch = this.#activeDispatch(workerName);
    const body = await req.json() as { specName?: string; name?: string };
    if (!body.specName || !body.name) {
      return errorResponse(400, "Expected { specName, name }");
    }

    const { createFileWriter } = createFileWriterFactory(
      this.#options.repoContext.unifiedDataRepo,
      dispatch.modelType,
      dispatch.modelId,
      dispatch.modelDef.files ?? {},
      undefined, // tagOverrides
      undefined, // dataOutputOverrides
      undefined, // callbacks
      dispatch.definitionTags,
      dispatch.runtimeTags,
      dispatch.definitionName,
    );
    const writer = createFileWriter(body.specName, body.name);
    const writerId = crypto.randomUUID();
    this.#writers.set(writerId, {
      writer,
      workerName,
      dispatchId: dispatch.dispatchId,
    });
    return json({ writerId, dataId: writer.dataId });
  }

  async #writerAction(
    req: Request,
    writerId: string,
    action: string,
    workerName: string,
  ): Promise<Response> {
    const session = this.#writers.get(writerId);
    if (!session || session.workerName !== workerName) {
      return errorResponse(404, `Unknown writer '${writerId}'`);
    }
    const dispatch = this.#activeDispatch(workerName);
    if (dispatch.dispatchId !== session.dispatchId) {
      return errorResponse(409, "Writer belongs to a finished dispatch");
    }

    switch (action) {
      case "line": {
        const text = await req.text();
        const lines = text.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") {
          lines.pop();
        }
        if (lines.length === 0) {
          return json({ ok: true });
        }
        await this.#recordWrite(dispatch);
        for (const line of lines) {
          await session.writer.writeLine(line);
        }
        return json({ ok: true });
      }
      case "content": {
        const body = req.body ?? ReadableStream.from<Uint8Array>([]);
        await this.#recordWrite(dispatch);
        const handle = await session.writer.writeStream(body);
        this.#writers.delete(writerId);
        return json(handleToJson(handle));
      }
      case "finalize": {
        await this.#recordWrite(dispatch);
        const handle = await session.writer.finalize();
        this.#writers.delete(writerId);
        return json(handleToJson(handle));
      }
      default:
        return errorResponse(404, `Unknown writer action '${action}'`);
    }
  }

  // ── /bundle routes ─────────────────────────────────────────────────────

  #handleBundle(req: Request, segments: string[]): Response {
    if (req.method !== "GET") {
      return errorResponse(405, "Bundles are read-only");
    }
    const fingerprint = segments[1];
    const bundle = fingerprint ? this.#options.bundles.get(fingerprint) : null;
    if (!bundle) {
      return errorResponse(404, `Unknown bundle fingerprint`);
    }

    if (segments.length === 2) {
      return new Response(bundle.js, {
        headers: {
          "content-type": "application/javascript",
          etag: `"${fingerprint}"`,
          "cache-control": "immutable, max-age=31536000",
        },
      });
    }

    if (segments.length === 3 && segments[2] === "files") {
      if (bundle.filesRoot === undefined) {
        return json({ files: [] });
      }
      return this.#listAssetFiles(bundle.filesRoot);
    }

    if (segments.length >= 4 && segments[2] === "file") {
      if (bundle.filesRoot === undefined) {
        return errorResponse(404, "Bundle has no co-located files");
      }
      const relPath = segments.slice(3).map(decodeURIComponent).join("/");
      const root = resolve(bundle.filesRoot);
      const target = resolve(join(root, normalize(relPath)));
      // The asset must stay within the extension's files root.
      if (
        isAbsolute(relPath) || relPath.includes("..") ||
        (!target.startsWith(root + "/") && target !== root &&
          !target.startsWith(root + "\\"))
      ) {
        return errorResponse(400, "Asset path escapes the bundle root");
      }
      return this.#serveAssetFile(target, fingerprint, relPath);
    }

    return errorResponse(404, "Unknown bundle route");
  }

  /**
   * Recursive relative listing of a bundle's co-located files, so a worker
   * can prefetch the whole (small) asset tree before executing — the
   * `extensionFile()` context member is synchronous and must resolve to a
   * local path.
   */
  #listAssetFiles(filesRoot: string): Response {
    const files: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of Deno.readDirSync(dir)) {
        const rel = prefix.length === 0
          ? entry.name
          : `${prefix}/${entry.name}`;
        if (entry.isDirectory) {
          walk(join(dir, entry.name), rel);
        } else if (entry.isFile) {
          files.push(rel);
        }
      }
    };
    try {
      walk(filesRoot, "");
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return json({ files: [] });
      }
      throw error;
    }
    return json({ files });
  }

  #serveAssetFile(
    target: string,
    fingerprint: string,
    relPath: string,
  ): Response {
    let bytes: Uint8Array;
    try {
      bytes = Deno.readFileSync(target);
    } catch {
      return errorResponse(404, `No asset '${relPath}' in bundle`);
    }
    return new Response(bytes.buffer as ArrayBuffer, {
      headers: {
        "content-type": "application/octet-stream",
        etag: `"${fingerprint}-${relPath}"`,
        "cache-control": "immutable, max-age=31536000",
      },
    });
  }
}
