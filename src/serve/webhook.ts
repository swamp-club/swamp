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
 * HTTP webhook handler for triggering workflow runs from external events
 * (e.g. GitHub push webhooks). Verifies HMAC-SHA256 signatures and queues
 * workflow execution through executeWorkflowWithLocks.
 */

import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import type { WebhookPayload } from "../domain/expressions/model_resolver.ts";
import { UserError } from "../domain/errors.ts";
import { executeWorkflowWithLocks } from "./deps.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  extractFirstStepError,
  type WorkflowRunView,
} from "../libswamp/mod.ts";
import {
  createVerifier,
  isWebhookScheme,
  type VerifierConfig,
} from "./webhook_verifiers.ts";

const logger = getSwampLogger(["serve", "webhook"]);

/** Default signature header — used by the github scheme. */
const SIGNATURE_HEADER = "x-hub-signature-256";

/**
 * Builds the {@link WebhookPayload} exposed to a workflow's `trigger.inputs`
 * CEL expressions from a verified request. The body is JSON-parsed when
 * possible, falling back to the raw UTF-8 string for non-JSON payloads. Header
 * names are lowercased and the signature header is dropped so it can never leak
 * into workflow inputs.
 */
export function buildWebhookPayload(
  body: Uint8Array,
  headers: Headers,
  route: string,
  signatureHeader: string = SIGNATURE_HEADER,
): WebhookPayload {
  const text = new TextDecoder().decode(body);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON payload — expose the raw string.
  }

  const excluded = signatureHeader.toLowerCase();
  const exposedHeaders: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === excluded) continue;
    exposedHeaders[lower] = value;
  }

  return { body: parsed, headers: exposedHeaders, route };
}

// ── Value Objects ──────────────────────────────────────────────────────

/**
 * Immutable configuration for a single webhook endpoint.
 * Parsed from --webhook CLI flags.
 */
export interface WebhookEndpoint {
  readonly route: string;
  readonly workflowIdOrName: string;
  readonly secret: string;
  readonly verifier: VerifierConfig;
}

/**
 * Parse a --webhook flag value into a WebhookEndpoint.
 *
 * Format: `<route>:<workflow>:<secret>[:<scheme>[:<header>[:<prefix>]]]`
 *
 * The scheme is recognized only when the fourth field is a known scheme
 * keyword; otherwise the flag is parsed the legacy way — the secret is
 * everything after the second colon (so it may still contain colons) and the
 * scheme defaults to github. This keeps every existing flag working. The
 * consequence (a colon-bearing secret cannot be combined with an explicit
 * scheme, and a secret whose colon-tail begins with a reserved keyword would be
 * reinterpreted) is the accepted limitation tracked in #723. When a scheme is
 * given, the remaining fields are positional: `generic` additionally takes a
 * header name (fifth, required) and a value prefix (sixth, optional).
 */
export function parseWebhookFlag(flag: string): WebhookEndpoint {
  const fields = flag.split(":");
  const usage =
    "expected '<route>:<workflow>:<secret>[:<scheme>[:<header>[:<prefix>]]]'";

  if (fields.length < 3) {
    throw new UserError(`Invalid --webhook format: ${usage}, got '${flag}'`);
  }

  const route = fields[0];
  const workflowIdOrName = fields[1];

  let secret: string;
  let verifier: VerifierConfig;

  if (fields.length >= 4 && isWebhookScheme(fields[3])) {
    // Scheme-qualified form: fields are positional, so the secret cannot
    // contain a colon here.
    secret = fields[2];
    const scheme = fields[3];
    if (scheme === "generic") {
      const header = fields[4];
      if (!header) {
        throw new UserError(
          "Invalid --webhook format: the 'generic' scheme requires a header " +
            `name (<route>:<workflow>:<secret>:generic:<header>[:<prefix>]), got '${flag}'`,
        );
      }
      verifier = { scheme, header, prefix: fields[5] ?? "" };
    } else {
      verifier = { scheme };
    }
  } else {
    // Legacy form: secret is everything after the second colon (may contain
    // colons); scheme defaults to github.
    const firstColon = flag.indexOf(":");
    const secondColon = flag.indexOf(":", firstColon + 1);
    secret = flag.slice(secondColon + 1);
    verifier = { scheme: "github" };
  }

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

  return { route, workflowIdOrName, secret, verifier };
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
  /** Shared sync service; see `design/datastores.md` markDirty contract. */
  syncService?: DatastoreSyncService;
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
  readonly scheme: string;
}

export class WebhookService {
  private readonly runQueue: Array<{
    workflowIdOrName: string;
    route: string;
    payload: WebhookPayload;
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
      scheme: e.verifier.scheme,
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

    const verifier = createVerifier(endpoint.verifier);

    for (const header of verifier.requiredHeaders) {
      if (!req.headers.get(header)) {
        this.emit({
          kind: "webhook_rejected",
          route: endpoint.route,
          reason: `Missing ${header} header`,
        });
        return Response.json(
          { error: `Missing ${header} header` },
          { status: 401 },
        );
      }
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

    // Any verification failure (malformed value, stale timestamp, mismatch)
    // returns a uniform 401 so the response cannot be used as an oracle.
    const valid = await verifier.verify(body, req.headers, endpoint.secret);
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
      payload: buildWebhookPayload(
        body,
        req.headers,
        endpoint.route,
        verifier.signatureHeader,
      ),
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
      this.processingPromise = this.processQueue().catch(
        (error: unknown) => {
          logger.error("Webhook queue processing failed: {error}", {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
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
        const { workflowIdOrName, route, payload } = this.runQueue.shift()!;
        await this.executeWorkflow(workflowIdOrName, route, payload);
      }
    } finally {
      this.processing = false;
    }
  }

  private async executeWorkflow(
    workflowIdOrName: string,
    route: string,
    payload: WebhookPayload,
  ): Promise<void> {
    const controller = new AbortController();
    const execId = crypto.randomUUID();
    this.running.set(execId, controller);

    try {
      let runId = "";
      let completedRun: WorkflowRunView | undefined;

      await executeWorkflowWithLocks(
        this.deps.repoDir,
        this.deps.repoContext,
        this.deps.datastoreConfig,
        { workflowIdOrName, webhook: payload },
        controller.signal,
        (event) => {
          if (event.kind === "started") {
            runId = event.runId;
          }
          if (event.kind === "completed") {
            completedRun = event.run;
          }
        },
        this.deps.syncService,
      );

      if (completedRun?.status === "failed") {
        const message = extractFirstStepError(completedRun);
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
      } else {
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
      }
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
      this.running.delete(execId);
    }
  }

  private emit(event: WebhookEvent): void {
    this.eventHandler?.(event);
  }
}
