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
 * Worker-side client for the orchestrator's HTTP data plane (see
 * design/enablers/remote-execution.md, "Data plane: two transports").
 *
 * All byte-heavy traffic rides here: artifact reads (cached by immutable
 * (dataId, version) identity), writes through orchestrator-side writers,
 * bundle and co-located asset fetches. Every request presents the sliding
 * session credential and carries an abort-able timeout: reads give up after
 * {@link DATA_PLANE_TIMEOUT_MS}, unary writes after the much longer
 * {@link DATA_PLANE_WRITE_TIMEOUT_MS}.
 */

import { createTlsHttpClient } from "../cli/remote_run.ts";
import {
  observationOutcome,
  observeExecution,
} from "../domain/remote/observability.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type {
  FileWriterOverrides,
  ResourceWriteOverrides,
} from "../domain/models/model.ts";
import {
  DISPATCH_SECRETS_PATH,
  type DispatchSecretLoadReference,
  type DispatchSecretLoadRefusal,
  DispatchSecretLoadRefusalSchema,
  DispatchSecretLoadResponseSchema,
  MAX_DISPATCH_SECRET_CLAIMS,
  MAX_DISPATCH_SECRET_LOADS,
} from "../domain/remote/protocol.ts";
import { secretReadKey } from "../domain/vaults/secret_loader.ts";

const logger = getSwampLogger(["worker", "data-plane"]);

/** Default per-request timeout for unary data-plane reads. */
export const DATA_PLANE_TIMEOUT_MS = 60_000;

/**
 * Default per-request timeout for unary data-plane writes. Serve saves a write
 * it has accepted even when the worker stops waiting, and the write routes are
 * not idempotent, so a write cannot be retried: giving up early on a slow or
 * stalled serve would fail a step whose data was saved (swamp-club#3519).
 */
export const DATA_PLANE_WRITE_TIMEOUT_MS = 15 * 60_000;

export interface RemoteDataHandle {
  dataId: string;
  name: string;
  specName: string;
  kind: "resource" | "file";
  version: number;
  size: number;
  tags: Record<string, string>;
}

/**
 * Why the protected load route gave no value for a dispatch's references
 * (design/enablers/typed-secrets.md Section 9): its refusal code, and the
 * reference it names when one caused it. It never carries a value, nor the
 * reply's own text.
 */
export class DispatchSecretLoadError extends Error {
  readonly code: DispatchSecretLoadRefusal | "malformed_reply";
  readonly status: number;
  readonly reference?: { vaultName: string; key: string };

  constructor(
    status: number,
    code: DispatchSecretLoadRefusal | "malformed_reply",
    reference?: { vaultName: string; key: string },
  ) {
    super(
      reference
        ? `Serve refused to load secret '${reference.key}' from vault '${reference.vaultName}' for this dispatch (${code}, HTTP ${status})`
        : `Serve refused to load this dispatch's secrets (${code}, HTTP ${status})`,
    );
    this.name = "DispatchSecretLoadError";
    this.status = status;
    this.code = code;
    this.reference = reference;
  }
}

/**
 * `references` split into requests the load route admits: at most
 * {@link MAX_DISPATCH_SECRET_LOADS} references, claiming at most
 * {@link MAX_DISPATCH_SECRET_CLAIMS} distinct resources, each.
 */
function loadChunks(
  references: readonly DispatchSecretLoadReference[],
): DispatchSecretLoadReference[][] {
  const chunks: DispatchSecretLoadReference[][] = [];
  let chunk: DispatchSecretLoadReference[] = [];
  let claims = new Set<string>();
  for (const reference of references) {
    const claim = reference.resource
      ? `${reference.resource.name}\u0000${reference.resource.version}`
      : undefined;
    const newClaim = claim !== undefined && !claims.has(claim);
    if (
      chunk.length >= MAX_DISPATCH_SECRET_LOADS ||
      (newClaim && claims.size >= MAX_DISPATCH_SECRET_CLAIMS)
    ) {
      chunks.push(chunk);
      chunk = [];
      claims = new Set();
    }
    chunk.push(reference);
    if (claim !== undefined) claims.add(claim);
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export interface DataPlaneClientOptions {
  baseUrl: string;
  credential: () => string;
  /** Per-request timeout for reads; bulk uploads get no upper bound. */
  timeoutMs?: number;
  /** Per-request timeout for unary writes. */
  writeTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Maximum cached artifacts before oldest is evicted. Defaults to 1000. */
  maxCacheEntries?: number;
  /** Extra headers for proxy/tunnel pass-through (env: SWAMP_SERVE_EXTRA_HEADERS). */
  extraHeaders?: Record<string, string>;
}

function combineSignals(
  timeoutSignal: AbortSignal | undefined,
  signal?: AbortSignal,
): AbortSignal | undefined {
  const signals = [timeoutSignal, signal].filter((s) => s !== undefined);
  if (signals.length === 0) {
    return undefined;
  }
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

export class DataPlaneClient {
  readonly #options: DataPlaneClientOptions;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #writeTimeoutMs: number;
  readonly #maxCacheEntries: number;
  /** Immutable (contentPath) → bytes. Versioned handles never change. */
  readonly #artifactCache = new Map<string, Uint8Array>();

  constructor(options: DataPlaneClientOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DATA_PLANE_TIMEOUT_MS;
    this.#writeTimeoutMs = options.writeTimeoutMs ??
      DATA_PLANE_WRITE_TIMEOUT_MS;
    this.#maxCacheEntries = options.maxCacheEntries ?? 1_000;
  }

  get cachedArtifactCount(): number {
    return this.#artifactCache.size;
  }

  async #request(
    method: string,
    path: string,
    init?: {
      body?: BodyInit;
      signal?: AbortSignal;
      timeoutMs?: number | null;
      /** A unary write: bounded by the write timeout, not the read one. */
      write?: boolean;
      headers?: Record<string, string>;
      /**
       * Hand back a reply that is not OK rather than throw on it, for a
       * caller that reads the refusal body itself and must never echo it.
       */
      refusalsToCaller?: boolean;
    },
  ): Promise<Response> {
    const url = new URL(path, this.#options.baseUrl);
    const timeoutMs = init?.timeoutMs !== undefined
      ? init.timeoutMs
      : init?.write
      ? this.#writeTimeoutMs
      : this.#timeoutMs;
    const timeoutSignal = timeoutMs === null
      ? undefined
      : AbortSignal.timeout(timeoutMs);
    let response: Response;
    const requestId = crypto.randomUUID();
    const observation = observeExecution("data.client", {
      "swamp.request.id": requestId,
      "swamp.data.write": init?.write ?? false,
    });
    try {
      response = await observation.run(() =>
        this.#fetch(url, {
          method,
          body: init?.body,
          headers: {
            ...this.#options.extraHeaders,
            authorization: `Bearer ${this.#options.credential()}`,
            ...init?.headers,
            ...observation.carrier,
            "x-swamp-request-id": requestId,
          },
          signal: combineSignals(timeoutSignal, init?.signal),
        })
      );
    } catch (error) {
      observation.attributes({
        "swamp.commit.state": init?.write ? "unknown" : "not_applicable",
        "swamp.reconciliation": "unsupported",
      });
      observation.end(
        init?.signal?.aborted
          ? "cancelled"
          : timeoutSignal?.aborted
          ? "timeout"
          : observationOutcome(error),
      );
      // Only this request's own deadline is reworded. The bare DOMException
      // text ("The operation was aborted due to timeout") names neither serve
      // nor the request, and a cancelled step keeps its own abort reason.
      if (timeoutSignal?.aborted && !init?.signal?.aborted) {
        throw new Error(
          `Serve did not answer ${method} ${path} within ` +
            `${timeoutMs! / 1000}s` +
            (init?.write ? "; serve may still have saved this write" : ""),
          { cause: error },
        );
      }
      throw error;
    }
    if (!response.ok && init?.refusalsToCaller) {
      observation.attributes({ "http.response.status_code": response.status });
      observation.end("error");
      return response;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      observation.attributes({ "http.response.status_code": response.status });
      observation.end("error");
      throw new Error(
        `Data plane ${method} ${path} failed (${response.status}): ${detail}`,
      );
    }
    observation.attributes({ "http.response.status_code": response.status });
    if (!response.body) {
      observation.end("ok");
      return response;
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            observation.attributes({ "swamp.response.bytes": bytes });
            observation.end("ok");
            reader.releaseLock();
            controller.close();
          } else {
            bytes += result.value.byteLength;
            controller.enqueue(result.value);
          }
        } catch (error) {
          observation.attributes({
            "swamp.response.bytes": bytes,
            "swamp.response.partial": true,
            "swamp.commit.state": init?.write ? "unknown" : "not_applicable",
            "swamp.reconciliation": "unsupported",
          });
          observation.end(
            init?.signal?.aborted
              ? "cancelled"
              : timeoutSignal?.aborted
              ? "timeout"
              : observationOutcome(error),
          );
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        observation.end("cancelled");
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    }, { highWaterMark: 0 });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * Loads the values behind a dispatch's references through the protected
   * route (`POST /data/secrets`, design/enablers/typed-secrets.md Section
   * 9), with the dispatch credential this client presents. Each distinct
   * reference is asked for once, in requests the route admits, and the
   * values come back keyed by {@link secretReadKey}. The route answers all
   * or nothing, so a refusal throws a {@link DispatchSecretLoadError} that
   * names its code and reference and never a value. Nothing is cached.
   */
  async loadSecrets(
    references: readonly DispatchSecretLoadReference[],
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const distinct = new Map<string, DispatchSecretLoadReference>();
    for (const reference of references) {
      const id = secretReadKey(reference);
      // A claim only widens what serve admits, so the first one is kept.
      if (!distinct.has(id)) distinct.set(id, reference);
    }
    const values = new Map<string, string>();
    for (const chunk of loadChunks([...distinct.values()])) {
      const response = await this.#request("POST", DISPATCH_SECRETS_PATH, {
        body: JSON.stringify({ references: chunk }),
        headers: { "content-type": "application/json" },
        signal,
        refusalsToCaller: true,
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new DispatchSecretLoadError(response.status, "malformed_reply");
      }
      if (!response.ok) {
        const refusal = DispatchSecretLoadRefusalSchema.safeParse(body);
        throw refusal.success
          ? new DispatchSecretLoadError(
            response.status,
            refusal.data.code,
            refusal.data.reference,
          )
          : new DispatchSecretLoadError(response.status, "malformed_reply");
      }
      const reply = DispatchSecretLoadResponseSchema.safeParse(body);
      if (!reply.success) {
        throw new DispatchSecretLoadError(response.status, "malformed_reply");
      }
      for (const { vaultName, key, value } of reply.data.values) {
        values.set(secretReadKey({ vaultName, key }), value);
      }
    }
    return values;
  }

  /** Read artifact bytes by data-plane content path; cached forever. */
  async readArtifact(
    contentPath: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const cached = this.#artifactCache.get(contentPath);
    if (cached !== undefined) {
      return cached;
    }
    const response = await this.#request("GET", contentPath, { signal });
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.#artifactCache.set(contentPath, bytes);
    if (this.#artifactCache.size > this.#maxCacheEntries) {
      const oldest = this.#artifactCache.keys().next().value;
      if (oldest !== undefined) {
        this.#artifactCache.delete(oldest);
      }
    }
    return bytes;
  }

  async writeResource(
    body: {
      specName: string;
      name: string;
      data: Record<string, unknown>;
      overrides?: ResourceWriteOverrides;
    },
    signal?: AbortSignal,
  ): Promise<RemoteDataHandle> {
    const response = await this.#request("POST", "/data/resource", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      signal,
      write: true,
    });
    return await response.json() as RemoteDataHandle;
  }

  async deleteResource(
    body: { name: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#request("DELETE", "/data/resource", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      signal,
      write: true,
    });
  }

  async openWriter(
    body: { specName: string; name: string; overrides?: FileWriterOverrides },
    signal?: AbortSignal,
  ): Promise<{ writerId: string; dataId: string }> {
    const response = await this.#request("POST", "/data/writers", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      signal,
      write: true,
    });
    return await response.json() as { writerId: string; dataId: string };
  }

  /** Durable once resolved — the live-log append contract. */
  async writeLine(
    writerId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.#request(
      "POST",
      `/data/writers/${writerId}/line`,
      {
        body: text,
        signal,
        write: true,
      },
    );
    // The successful headers acknowledge the append. Body cleanup cannot
    // revoke that result; the response observation records transport failure.
    await response.body?.cancel().catch(() => {});
  }

  /** Stream content to the writer and finalize it. No upper time bound. */
  async writeContent(
    writerId: string,
    content: Uint8Array | ReadableStream<Uint8Array> | string,
    signal?: AbortSignal,
  ): Promise<RemoteDataHandle> {
    const response = await this.#request(
      "POST",
      `/data/writers/${writerId}/content`,
      // Uint8Array views are valid fetch bodies; the lib typing is narrower.
      { body: content as BodyInit, signal, timeoutMs: null, write: true },
    );
    return await response.json() as RemoteDataHandle;
  }

  async finalizeWriter(
    writerId: string,
    signal?: AbortSignal,
  ): Promise<RemoteDataHandle> {
    const response = await this.#request(
      "POST",
      `/data/writers/${writerId}/finalize`,
      { signal, write: true },
    );
    return await response.json() as RemoteDataHandle;
  }

  async fetchBundle(
    fingerprint: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.#request(
      "GET",
      `/bundle/${encodeURIComponent(fingerprint)}`,
      { signal, timeoutMs: null },
    );
    return await response.text();
  }

  async fetchAsset(
    fingerprint: string,
    relPath: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const encoded = relPath.split("/").map(encodeURIComponent).join("/");
    const response = await this.#request(
      "GET",
      `/bundle/${encodeURIComponent(fingerprint)}/file/${encoded}`,
      { signal },
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async listAssets(
    fingerprint: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const response = await this.#request(
      "GET",
      `/bundle/${encodeURIComponent(fingerprint)}/files`,
      { signal },
    );
    const body = await response.json() as { files: string[] };
    return body.files;
  }
}

/** Data-plane fetch that trusts the worker's `--ca-cert` certificates, if any. */
export function createDataPlaneFetch(
  caCerts: string[] | undefined,
  createClient: (options: Deno.CreateHttpClientOptions) => Deno.HttpClient =
    createTlsHttpClient,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  if (!caCerts?.length) {
    return baseFetch;
  }
  const client = createClient({ caCerts });
  return (input, init) => baseFetch(input, { ...init, client });
}

/** Derives the data-plane base URL from the control-socket connect URL. */
export function dataPlaneUrlFromConnectUrl(connectUrl: string): string {
  const url = new URL(connectUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  logger.debug("Derived data plane url {url}", { url: url.href });
  return url.href;
}
