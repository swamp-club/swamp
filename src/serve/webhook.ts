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

/**
 * HTTP webhook handler for triggering workflow runs from external events
 * (e.g. GitHub push webhooks). Verifies HMAC-SHA256 signatures and queues
 * workflow execution through executeWorkflowWithLocks.
 */

import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import { UserError } from "../domain/errors.ts";
import { executeWorkflowWithLocks } from "./deps.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "webhook"]);

// ── Value Objects ──────────────────────────────────────────────────────

/**
 * Immutable configuration for a single webhook endpoint.
 * Parsed from --webhook CLI flags.
 */
export interface WebhookEndpoint {
  readonly route: string;
  readonly workflowIdOrName: string;
  readonly secret: string;
}

/**
 * Parse a --webhook flag value into a WebhookEndpoint.
 * Format: <route>:<workflow>:<secret>
 *
 * The secret is everything after the second colon, allowing colons
 * within the secret itself.
 */
export function parseWebhookFlag(flag: string): WebhookEndpoint {
  const firstColon = flag.indexOf(":");
  if (firstColon === -1) {
    throw new UserError(
      `Invalid --webhook format: expected '<route>:<workflow>:<secret>', got '${flag}'`,
    );
  }
  const secondColon = flag.indexOf(":", firstColon + 1);
  if (secondColon === -1) {
    throw new UserError(
      `Invalid --webhook format: expected '<route>:<workflow>:<secret>', got '${flag}'`,
    );
  }

  const route = flag.slice(0, firstColon);
  const workflowIdOrName = flag.slice(firstColon + 1, secondColon);
  const secret = flag.slice(secondColon + 1);

  if (!route || !workflowIdOrName || !secret) {
    throw new UserError(
      `Invalid --webhook format: route, workflow, and secret must all be non-empty. Got '${flag}'`,
    );
  }

  if (!route.startsWith("/")) {
    throw new UserError(
      `Invalid --webhook route: must start with '/', got '${route}'`,
    );
  }

  return { route, workflowIdOrName, secret };
}

// ── HMAC Signature Verification ────────────────────────────────────────

/**
 * Verify a GitHub-style HMAC-SHA256 signature.
 *
 * @param body - Raw request body bytes
 * @param signatureHeader - The X-Hub-Signature-256 header value (sha256=<hex>)
 * @param secret - The shared secret string
 * @returns true if the signature is valid
 */
export async function verifySignature(
  body: Uint8Array,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const receivedHex = signatureHeader.slice("sha256=".length);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  // body is always a freshly-allocated Uint8Array from readBodyWithLimit
  // or TextEncoder, so .buffer is a plain ArrayBuffer (not SharedArrayBuffer)
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    body.buffer as ArrayBuffer,
  );
  const expectedHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison: always compare all characters
  if (receivedHex.length !== expectedHex.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    mismatch |= receivedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }

  return mismatch === 0;
}

// ── Body Size Limit ────────────────────────────────────────────────────

/**
 * Read a request body with a byte budget. Returns null if the body
 * exceeds the limit, cancelling the stream to avoid full allocation.
 */
async function readBodyWithLimit(
  req: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// ── Webhook Event Types ────────────────────────────────────────────────

export type WebhookEvent =
  | {
    kind: "webhook_received";
    route: string;
    workflowName: string;
  }
  | {
    kind: "webhook_rejected";
    route: string;
    reason: string;
  }
  | {
    kind: "webhook_queued";
    route: string;
    workflowName: string;
  }
  | {
    kind: "webhook_completed";
    route: string;
    workflowName: string;
    runId: string;
  }
  | {
    kind: "webhook_failed";
    route: string;
    workflowName: string;
    error: string;
  };

export type WebhookEventHandler = (event: WebhookEvent) => void;

// ── Webhook Execution Service ──────────────────────────────────────────

export interface WebhookServiceDeps {
  repoDir: string;
  repoContext: RepositoryContext;
  datastoreConfig: DatastoreConfig;
  endpoints: WebhookEndpoint[];
}

/**
 * WebhookService manages webhook endpoint matching, signature verification,
 * and serialized workflow execution. Queues runs to avoid lock contention,
 * matching the pattern used by ScheduledExecutionService.
 */
const MAX_WEBHOOK_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_QUEUE_DEPTH = 100;

/**
 * Webhook endpoint info exposed to callers, without the secret.
 */
export interface WebhookEndpointInfo {
  readonly route: string;
  readonly workflowIdOrName: string;
}

export class WebhookService {
  private readonly runQueue: Array<{
    workflowIdOrName: string;
    route: string;
  }> = [];
  private processing = false;
  private processingPromise: Promise<void> = Promise.resolve();
  private eventHandler: WebhookEventHandler | null = null;
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly deps: WebhookServiceDeps) {}

  setEventHandler(handler: WebhookEventHandler): void {
    this.eventHandler = handler;
  }

  /**
   * Returns the configured webhook endpoints (without secrets).
   */
  listEndpoints(): ReadonlyArray<WebhookEndpointInfo> {
    return this.deps.endpoints.map((e) => ({
      route: e.route,
      workflowIdOrName: e.workflowIdOrName,
    }));
  }

  /**
   * Handle an incoming HTTP request. Returns a Response if the request
   * matches a configured webhook route, or null if no route matched.
   */
  async handleRequest(req: Request): Promise<Response | null> {
    if (req.method !== "POST") {
      return null;
    }

    const url = new URL(req.url);
    const endpoint = this.deps.endpoints.find((e) => e.route === url.pathname);
    if (!endpoint) {
      return null;
    }

    this.emit({
      kind: "webhook_received",
      route: endpoint.route,
      workflowName: endpoint.workflowIdOrName,
    });

    // Reject missing signature before reading the body to avoid
    // unauthenticated resource consumption
    const signatureHeader = req.headers.get("x-hub-signature-256") ?? "";
    if (!signatureHeader) {
      this.emit({
        kind: "webhook_rejected",
        route: endpoint.route,
        reason: "Missing X-Hub-Signature-256 header",
      });
      return Response.json(
        { error: "Missing X-Hub-Signature-256 header" },
        { status: 401 },
      );
    }

    // Read body with size limit — streams to avoid unbounded allocation
    const body = await readBodyWithLimit(req, MAX_WEBHOOK_BODY_BYTES);
    if (body === null) {
      this.emit({
        kind: "webhook_rejected",
        route: endpoint.route,
        reason: "Request body too large",
      });
      return Response.json(
        { error: "Request body too large" },
        { status: 413 },
      );
    }

    const valid = await verifySignature(body, signatureHeader, endpoint.secret);
    if (!valid) {
      this.emit({
        kind: "webhook_rejected",
        route: endpoint.route,
        reason: "Invalid signature",
      });
      return Response.json(
        { error: "Invalid signature" },
        { status: 401 },
      );
    }

    // Queue the workflow run (with backpressure)
    if (this.runQueue.length >= MAX_QUEUE_DEPTH) {
      this.emit({
        kind: "webhook_rejected",
        route: endpoint.route,
        reason: "Queue full",
      });
      return Response.json(
        { error: "Too many queued runs, try again later" },
        { status: 503 },
      );
    }

    this.runQueue.push({
      workflowIdOrName: endpoint.workflowIdOrName,
      route: endpoint.route,
    });

    this.emit({
      kind: "webhook_queued",
      route: endpoint.route,
      workflowName: endpoint.workflowIdOrName,
    });

    logger.info(
      "Webhook received on {route}, queued workflow {workflow}",
      { route: endpoint.route, workflow: endpoint.workflowIdOrName },
    );

    // Start processing the queue — only store when actually starting
    if (!this.processing) {
      this.processingPromise = this.processQueue();
    }

    return Response.json({
      status: "queued",
      workflow: endpoint.workflowIdOrName,
    });
  }

  /**
   * Gracefully stop: abort in-flight runs and drain the processing promise.
   */
  async stop(): Promise<void> {
    this.runQueue.length = 0;
    for (const controller of this.running.values()) {
      controller.abort();
    }
    await this.processingPromise;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.runQueue.length > 0) {
        const { workflowIdOrName, route } = this.runQueue.shift()!;
        await this.executeWorkflow(workflowIdOrName, route);
      }
    } finally {
      this.processing = false;
    }
  }

  private async executeWorkflow(
    workflowIdOrName: string,
    route: string,
  ): Promise<void> {
    const controller = new AbortController();
    this.running.set(workflowIdOrName, controller);

    try {
      let runId = "";

      await executeWorkflowWithLocks(
        this.deps.repoDir,
        this.deps.repoContext,
        this.deps.datastoreConfig,
        { workflowIdOrName },
        controller.signal,
        (event) => {
          if (event.kind === "started") {
            runId = event.runId;
          }
        },
      );

      this.emit({
        kind: "webhook_completed",
        route,
        workflowName: workflowIdOrName,
        runId,
      });
      logger.info(
        "Webhook workflow {workflow} completed (run: {runId})",
        { workflow: workflowIdOrName, runId },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        logger.info("Webhook workflow {workflow} aborted", {
          workflow: workflowIdOrName,
        });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        kind: "webhook_failed",
        route,
        workflowName: workflowIdOrName,
        error: message,
      });
      logger.error(
        "Webhook workflow {workflow} failed: {error}",
        { workflow: workflowIdOrName, error: message },
      );
    } finally {
      this.running.delete(workflowIdOrName);
    }
  }

  private emit(event: WebhookEvent): void {
    this.eventHandler?.(event);
  }
}
