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
 * design/remote-execution.md, "Data plane: two transports").
 *
 * All byte-heavy traffic rides here: artifact reads (cached by immutable
 * (dataId, version) identity), writes through orchestrator-side writers,
 * bundle and co-located asset fetches. Every request presents the sliding
 * session credential and carries an abort-able timeout.
 */

import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["worker", "data-plane"]);

/** Default per-request timeout for unary data-plane calls. */
export const DATA_PLANE_TIMEOUT_MS = 60_000;

export interface RemoteDataHandle {
  dataId: string;
  name: string;
  specName: string;
  kind: "resource" | "file";
  version: number;
  size: number;
  tags: Record<string, string>;
}

export interface DataPlaneClientOptions {
  baseUrl: string;
  credential: () => string;
  /** Per-request timeout; bulk uploads get no upper bound. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Maximum cached artifacts before oldest is evicted. Defaults to 1000. */
  maxCacheEntries?: number;
}

function combineSignals(
  timeoutMs: number | null,
  signal?: AbortSignal,
): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (timeoutMs !== null) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }
  if (signal) {
    signals.push(signal);
  }
  if (signals.length === 0) {
    return undefined;
  }
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

export class DataPlaneClient {
  readonly #options: DataPlaneClientOptions;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxCacheEntries: number;
  /** Immutable (contentPath) → bytes. Versioned handles never change. */
  readonly #artifactCache = new Map<string, Uint8Array>();

  constructor(options: DataPlaneClientOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DATA_PLANE_TIMEOUT_MS;
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
      headers?: Record<string, string>;
    },
  ): Promise<Response> {
    const url = new URL(path, this.#options.baseUrl);
    const response = await this.#fetch(url, {
      method,
      body: init?.body,
      headers: {
        authorization: `Bearer ${this.#options.credential()}`,
        ...init?.headers,
      },
      signal: combineSignals(
        init?.timeoutMs === undefined ? this.#timeoutMs : init.timeoutMs,
        init?.signal,
      ),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Data plane ${method} ${path} failed (${response.status}): ${detail}`,
      );
    }
    return response;
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
    body: { specName: string; name: string; data: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<RemoteDataHandle> {
    const response = await this.#request("POST", "/data/resource", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      signal,
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
    });
  }

  async openWriter(
    body: { specName: string; name: string },
    signal?: AbortSignal,
  ): Promise<{ writerId: string; dataId: string }> {
    const response = await this.#request("POST", "/data/writers", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      signal,
    });
    return await response.json() as { writerId: string; dataId: string };
  }

  /** Durable once resolved — the live-log append contract. */
  async writeLine(
    writerId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#request("POST", `/data/writers/${writerId}/line`, {
      body: text,
      signal,
    });
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
      { body: content as BodyInit, signal, timeoutMs: null },
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
      { signal },
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
