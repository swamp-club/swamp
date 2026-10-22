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
import { errorPaths, markErrorPaths, UserError } from "../domain/errors.ts";
import { executeWorkflowWithLocks } from "./deps.ts";
import { withoutVaultAccess } from "../domain/vaults/run_vault_access.ts";
import type { ServeRunVaultScope } from "./run_vault_access_policy.ts";
import type { SyncGate } from "./sync_gate.ts";
import { deleteActiveRun, writeActiveRun } from "./active_run_tracker.ts";
import { runDetached } from "../infrastructure/tracing/mod.ts";
import {
  type ExecutionObservation,
  observeExecution,
  observeExecutionWork,
  type TraceCarrier,
  traceCarrier,
} from "../domain/remote/observability.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  extractFirstStepError,
  type WorkflowRunView,
} from "../libswamp/workflows/workflow_run_view.ts";
import type { WebhookResponse } from "../domain/webhooks/webhook_handler.ts";
import { webhookTypeRegistry } from "../domain/webhooks/webhook_type_registry.ts";
import {
  isExtensionWebhookScheme,
  isWebhookScheme,
  resolveWebhookHandler,
  type VerifierConfig,
} from "./webhook_verifiers.ts";

const logger = getSwampLogger(["serve", "webhook"]);

/** Default signature header — used by the github scheme. */
const SIGNATURE_HEADER = "x-hub-signature-256";

const REDACTED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-hub-signature",
  "x-shopify-hmac-sha256",
  "x-amzn-oidc-accesstoken",
  "x-amzn-oidc-data",
  "x-goog-iap-jwt-assertion",
  "cf-access-jwt-assertion",
  "x-forwarded-client-cert",
]);

const REDACTED_HEADER_SUFFIXES: readonly string[] = [
  "-token",
  "-secret",
];

export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (REDACTED_HEADERS.has(lower)) return true;
  return REDACTED_HEADER_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Builds the {@link WebhookPayload} exposed to a workflow's `trigger.inputs`
 * CEL expressions from a verified request. The body is JSON-parsed when
 * possible, falling back to the raw UTF-8 string for non-JSON payloads. Header
 * names are lowercased; the signature header and sensitive credential headers
 * are dropped so they can never leak into workflow inputs or persistent storage.
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
    if (isSensitiveHeader(lower)) continue;
    exposedHeaders[lower] = value;
  }

  return { body: parsed, headers: exposedHeaders, route };
}

// ── Secret Resolution ─────────────────────────────────────────────────

const ENV_PREFIX = "@env=";
const FILE_PREFIX = "@file=";
const VAULT_PREFIX = "@vault=";

export interface VaultSecretResolver {
  get(vaultName: string, secretKey: string): Promise<string>;
}

export async function resolveSecret(
  raw: string,
  vault?: VaultSecretResolver,
): Promise<string> {
  if (raw.startsWith(ENV_PREFIX)) {
    const varName = raw.slice(ENV_PREFIX.length);
    const value = Deno.env.get(varName);
    if (!value) {
      throw new UserError(
        `Webhook secret references environment variable '${varName}' ` +
          `(via ${ENV_PREFIX}), but it is not set or is empty`,
      );
    }
    return value;
  }

  if (raw.startsWith(FILE_PREFIX)) {
    const filePath = raw.slice(FILE_PREFIX.length);
    let content: string;
    try {
      content = Deno.readTextFileSync(filePath);
    } catch (cause) {
      throw markErrorPaths(
        new UserError(
          `Webhook secret references file '${filePath}' ` +
            `(via ${FILE_PREFIX}), but it could not be read: ${cause}`,
        ),
        [filePath, ...errorPaths(cause)],
      );
    }
    content = content.replace(/\r?\n$/, "");
    if (!content) {
      throw markErrorPaths(
        new UserError(
          `Webhook secret file '${filePath}' is empty`,
        ),
        [filePath],
      );
    }
    return content;
  }

  if (raw.startsWith(VAULT_PREFIX)) {
    const ref = raw.slice(VAULT_PREFIX.length);
    const colonIdx = ref.indexOf(":");
    if (colonIdx < 1) {
      throw new UserError(
        `Webhook secret uses ${VAULT_PREFIX} but the format is invalid: ` +
          `expected '@vault=<vault-name>:<key>', got '${raw}'`,
      );
    }
    const vaultName = ref.slice(0, colonIdx);
    const secretKey = ref.slice(colonIdx + 1);
    if (!secretKey) {
      throw new UserError(
        `Webhook secret uses ${VAULT_PREFIX} but the key is empty: ` +
          `expected '@vault=<vault-name>:<key>', got '${raw}'`,
      );
    }
    if (!vault) {
      throw new UserError(
        `Webhook secret references vault '${vaultName}' ` +
          `(via ${VAULT_PREFIX}), but no vault service is available. ` +
          `Ensure a vault is configured in your repo (see 'swamp vault create')`,
      );
    }
    try {
      const value = await vault.get(vaultName, secretKey);
      if (!value) {
        throw new UserError(
          `Vault '${vaultName}' returned an empty value for key '${secretKey}'`,
        );
      }
      return value;
    } catch (cause) {
      if (cause instanceof UserError) throw cause;
      throw new UserError(
        `Webhook secret could not be resolved from vault '${vaultName}', ` +
          `key '${secretKey}' (via ${VAULT_PREFIX}): ${cause}`,
      );
    }
  }

  return raw;
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
 * given, the remaining fields are positional: `generic` requires a header name
 * (fifth field) and accepts an optional value prefix (sixth field). A webhook
 * extension type (`@collective/name`) is also accepted as the scheme, with an
 * empty config.
 */
export async function parseWebhookFlag(
  flag: string,
  vault?: VaultSecretResolver,
): Promise<WebhookEndpoint> {
  const fields = flag.split(":");
  const usage =
    "expected '<route>:<workflow>:<secret>[:<scheme>[:<header>[:<prefix>]]]' " +
    "(note: generic scheme requires <header>)";

  if (fields.length < 3) {
    throw new UserError(`Invalid --webhook format: ${usage}, got '${flag}'`);
  }

  const route = fields[0];
  const workflowIdOrName = fields[1];

  let secret: string;
  let verifier: VerifierConfig;

  const extensionScheme = fields[3]?.toLowerCase() ?? "";
  if (fields.length >= 4 && isExtensionWebhookScheme(extensionScheme)) {
    // Extension scheme: config is only expressible in serve.yaml.
    secret = fields[2];
    verifier = { scheme: extensionScheme, config: {} };
  } else if (fields.length >= 4 && isWebhookScheme(fields[3])) {
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

  secret = await resolveSecret(secret, vault);

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

/**
 * Resolve every extension-scheme endpoint at startup: the webhook extension
 * type must be installed (or auto-resolvable) and its config must satisfy the
 * type's configSchema. Returns the endpoints with schema-parsed config.
 */
export async function resolveExtensionWebhookEndpoints(
  endpoints: readonly WebhookEndpoint[],
  resolveType: (type: string) => Promise<boolean>,
): Promise<WebhookEndpoint[]> {
  const resolved: WebhookEndpoint[] = [];
  for (const endpoint of endpoints) {
    const verifier = endpoint.verifier;
    if (!("config" in verifier)) {
      resolved.push(endpoint);
      continue;
    }
    const info = await resolveType(verifier.scheme)
      ? webhookTypeRegistry.get(verifier.scheme)
      : undefined;
    if (!info) {
      // The scheme is a webhook type, not an extension name — one
      // extension can ship several types under other names, so the hint
      // points at search rather than a pull of the scheme itself.
      throw new UserError(
        `Webhook ${endpoint.route} uses scheme '${verifier.scheme}', but no ` +
          `installed extension provides that webhook type. Pull the ` +
          `extension that ships it — find it with 'swamp extension search'.`,
      );
    }
    let config: Record<string, unknown> = { ...verifier.config };
    if (info.configSchema) {
      const result = info.configSchema.safeParse(config);
      if (!result.success) {
        throw new UserError(
          `Invalid config for webhook ${endpoint.route} ` +
            `(scheme '${verifier.scheme}'): ${result.error.message}`,
        );
      }
      config = result.data as Record<string, unknown>;
    }
    resolved.push({
      ...endpoint,
      verifier: { scheme: verifier.scheme, config },
    });
  }
  return resolved;
}

/** Convert an extension-supplied {@link WebhookResponse} to an HTTP response. */
function toHttpResponse(response: WebhookResponse): Response {
  // The Response constructor enforces the upper bound but permits 101.
  if (response.status < 200) {
    throw new RangeError(`invalid webhook response status ${response.status}`);
  }
  const headers = new Headers(response.headers);
  if (response.body === undefined) {
    return new Response(null, { status: response.status, headers });
  }
  if (typeof response.body === "string") {
    return new Response(response.body, { status: response.status, headers });
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers,
  });
}

// ── Body Size Limit ────────────────────────────────────────────────────

/**
 * Read a request body with a byte budget. Returns null if the body
 * exceeds the limit, cancelling the stream to avoid full allocation.
 */
export async function readBodyWithLimit(
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
    /** The workflow the route is configured to run. */
    workflowName: string;
    reason: string;
    /** The sender's address, when the caller supplied it. */
    sourceIp?: string;
  }
  | {
    kind: "webhook_queued";
    route: string;
    workflowName: string;
  }
  | {
    /** A run began executing; runId is known from here on. */
    kind: "webhook_started";
    route: string;
    workflowName: string;
    runId: string;
    sourceIp?: string;
    replayed: boolean;
  }
  | {
    /** Authorization refused the run; it never started. */
    kind: "webhook_denied";
    route: string;
    workflowName: string;
    reason: string;
    sourceIp?: string;
    replayed: boolean;
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
  /** Shared sync service; see `design/enablers/datastores.md` markDirty contract. */
  syncService?: DatastoreSyncService;
  /**
   * Serve's sync gate; webhook runs sync under its shared mode
   * (swamp-club#2405). Required — `undefined` where no gate exists — so the
   * wiring cannot be forgotten.
   */
  syncGate: SyncGate | undefined;
  runTracker?:
    import("../infrastructure/persistence/run_tracker_store.ts").RunTrackerStore;
  /** HA instance identifier — always generated at startup. */
  instanceId?: string;
  /** Remote control-plane store for HA dual-write of pending runs. */
  controlPlaneStore?:
    import("../domain/datastore/control_plane_store.ts").ControlPlaneStore;
  /** Recorded on every run as `initiatedBy` (the webhook principal). */
  initiatedBy?: string;
  /** The repo's `defaultVault`, forwarded to each run (swamp-club#3680). */
  defaultVault?: string;
  /**
   * Authorizes each run at execution time, so queued and replayed runs are
   * both checked against the current policy. When absent every run proceeds.
   */
  authorizeRun?: WebhookRunAuthorizer;
  /** Test seam; defaults to {@link executeWorkflowWithLocks}. */
  executeWorkflow?: typeof executeWorkflowWithLocks;
  /**
   * Builds, per run, the vault scope of the webhook principal
   * (swamp-club#2676). When absent runs are unscoped.
   */
  createVaultAccess?: () => ServeRunVaultScope | undefined;
  /**
   * How many webhook runs may be in flight at once, across every route.
   * Deliveries to the same route may overlap. Defaults to 1: one run at a
   * time, in arrival order.
   */
  maxConcurrentRuns?: number;
  /** Clock for queue-delay reporting, in epoch ms. Defaults to `Date.now`. */
  now?: () => number;
}

/** A webhook route's queue state, as reported in health. */
export interface WebhookQueueStatus {
  /** Runs taken off the queue and not yet settled. */
  readonly active: number;
  /** Deliveries waiting to start. */
  readonly queued: number;
  /** ISO-8601 enqueue time of the oldest waiting delivery. */
  readonly oldestQueuedAt: string | null;
  /** Enqueue-to-start delay of the last run that started. */
  readonly lastQueueDelayMs: number | null;
}

import type { WebhookAdmissionSnapshot } from "../domain/remote/run_progress.ts";

interface QueuedWebhookRun {
  lastProgressAt: string;
  admittedAt?: number;
  phaseStartedAt: number;
  runId?: string;
  queueObservation?: ExecutionObservation;
  receiptId?: string;
  receiptTrace?: TraceCarrier;
  pendingRunId?: string;
  putPromise?: Promise<void>;
  workflowIdOrName: string;
  route: string;
  payload: WebhookPayload;
  traceparent?: string;
  tracestate?: string;
  sourceIp?: string;
  replayed?: boolean;
  /** Epoch ms the entry joined the queue. */
  enqueuedAt: number;
}

/** What the webhook service asks before it starts a run. */
export interface WebhookRunRequest {
  readonly workflowIdOrName: string;
  readonly route: string;
  readonly sourceIp?: string;
  readonly replayed: boolean;
}

export interface WebhookRunAuthorization {
  readonly allowed: boolean;
  /** The workflow to run: exactly the value authorization decided on. */
  readonly workflowIdOrName: string;
  /**
   * The id of the workflow authorization decided on, when it exists; the run
   * record carries it so cancel and attach authorize that workflow.
   */
  readonly workflowId?: string;
  readonly reason?: string;
}

export type WebhookRunAuthorizer = (
  request: WebhookRunRequest,
) => Promise<WebhookRunAuthorization>;

/**
 * WebhookService manages webhook endpoint matching, signature verification,
 * and queued workflow execution. Up to `maxConcurrentRuns` queued runs
 * execute at once, as in ScheduledExecutionService, except that runs of the
 * same route or workflow may overlap: per-model locks guard shared state.
 */
const MAX_WEBHOOK_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_QUEUE_DEPTH = 100;
/**
 * Retry-After for deliveries rejected while serve shuts down. Short, so the
 * sender's retry lands on the replacement instance rather than waiting out
 * this one's drain.
 */
const SHUTDOWN_RETRY_AFTER_SECONDS = 5;

/**
 * Webhook endpoint info exposed to callers, without the secret.
 */
export interface WebhookEndpointInfo {
  readonly route: string;
  readonly workflowIdOrName: string;
  readonly scheme: string;
}

export class WebhookService {
  private readonly runQueue: QueuedWebhookRun[] = [];
  private readonly maxConcurrentRuns: number;
  private readonly now: () => number;
  /** Entries taken off the queue and not yet settled, by settle promise. */
  private readonly inFlight = new Map<Promise<void>, QueuedWebhookRun>();
  /** Last enqueue-to-start delay, by route. */
  private readonly lastQueueDelayMs = new Map<string, number>();
  private eventHandler: WebhookEventHandler | null = null;
  private readonly running = new Map<
    string,
    { controller: AbortController; runId: string }
  >();
  private draining = false;
  private stopped = false;
  private endpoints: WebhookEndpoint[];

  constructor(private readonly deps: WebhookServiceDeps) {
    this.endpoints = [...deps.endpoints];
    this.maxConcurrentRuns = Math.max(1, deps.maxConcurrentRuns ?? 1);
    this.now = deps.now ?? Date.now;
  }

  setEventHandler(handler: WebhookEventHandler): void {
    this.eventHandler = handler;
  }

  /** Admin-only diagnostics; receipt IDs are not workflow run IDs. */
  admissionSnapshots(): WebhookAdmissionSnapshot[] {
    const active = [...this.inFlight.values()];
    return [...this.runQueue, ...active].map((entry) => {
      const queued = entry.admittedAt === undefined;
      const blocked = queued && active.length >= this.maxConcurrentRuns
        ? active
        : [];
      return {
        receiptId: entry.receiptId ?? entry.pendingRunId ?? "unknown",
        workflow: entry.workflowIdOrName,
        phase: queued ? "queued" : entry.runId ? "executing" : "starting",
        phaseElapsedMs: Math.max(0, performance.now() - entry.phaseStartedAt),
        enqueuedAt: new Date(entry.enqueuedAt).toISOString(),
        lastProgressAt: entry.lastProgressAt,
        traceId: entry.receiptTrace?.traceparent.split("-")[1],
        runId: entry.runId,
        blockingRunIds: blocked.flatMap((item) =>
          item.runId ? [item.runId] : []
        ),
        unknownBlockers: blocked.filter((item) => !item.runId).length,
      };
    });
  }

  /**
   * Atomically replace the active endpoint list. In-flight runs continue
   * against their already-matched endpoint; new requests match against the
   * updated list. Returns the number of routes that changed (added + removed
   * + modified).
   */
  updateEndpoints(newEndpoints: readonly WebhookEndpoint[]): number {
    const oldByRoute = new Map(this.endpoints.map((e) => [e.route, e]));
    const newByRoute = new Map(newEndpoints.map((e) => [e.route, e]));

    let changed = 0;
    for (const [route, ep] of newByRoute) {
      const old = oldByRoute.get(route);
      if (!old) {
        changed++;
        logger.info("Webhook route added: {route} → {workflow} ({scheme})", {
          route,
          workflow: ep.workflowIdOrName,
          scheme: ep.verifier.scheme,
        });
      } else if (
        old.workflowIdOrName !== ep.workflowIdOrName ||
        old.secret !== ep.secret ||
        JSON.stringify(old.verifier) !== JSON.stringify(ep.verifier)
      ) {
        changed++;
        logger.info("Webhook route updated: {route} → {workflow} ({scheme})", {
          route,
          workflow: ep.workflowIdOrName,
          scheme: ep.verifier.scheme,
        });
      }
    }
    for (const route of oldByRoute.keys()) {
      if (!newByRoute.has(route)) {
        changed++;
        this.lastQueueDelayMs.delete(route);
        logger.info("Webhook route removed: {route}", { route });
      }
    }

    this.endpoints = [...newEndpoints];
    return changed;
  }

  /**
   * Returns the configured webhook endpoints (without secrets).
   */
  listEndpoints(): ReadonlyArray<WebhookEndpointInfo> {
    return this.endpoints.map((e) => ({
      route: e.route,
      workflowIdOrName: e.workflowIdOrName,
      scheme: e.verifier.scheme,
    }));
  }

  /**
   * Returns a route's queue state: its runs in flight, its deliveries waiting
   * to start, the oldest one's enqueue time, and the last run's
   * enqueue-to-start delay.
   */
  queueStatus(route: string): WebhookQueueStatus {
    let active = 0;
    for (const entry of this.inFlight.values()) {
      if (entry.route === route) active++;
    }
    const waiting = this.runQueue.filter((entry) => entry.route === route);
    const oldest = waiting.reduce<number | undefined>(
      (min, entry) =>
        min === undefined || entry.enqueuedAt < min ? entry.enqueuedAt : min,
      undefined,
    );
    return {
      active,
      queued: waiting.length,
      oldestQueuedAt: oldest === undefined
        ? null
        : new Date(oldest).toISOString(),
      lastQueueDelayMs: this.lastQueueDelayMs.get(route) ?? null,
    };
  }

  /**
   * Handle an incoming HTTP request. Returns a Response if the request
   * matches a configured webhook route, or null if no route matched.
   */
  async handleRequest(
    req: Request,
    sourceIp?: string,
  ): Promise<Response | null> {
    if (
      req.method !== "POST" ||
      !this.endpoints.some((endpoint) =>
        endpoint.route === new URL(req.url).pathname
      )
    ) {
      return null;
    }
    const receiptId = crypto.randomUUID();
    return await observeExecutionWork("webhook.receipt", {
      "swamp.webhook.receipt_id": receiptId,
    }, async (observation) => {
      const response = await this.handleObservedRequest(
        req,
        sourceIp,
        receiptId,
        observation,
      );
      observation.attributes({
        "http.response.status_code": response?.status ?? 404,
      });
      if (response && response.status >= 400) observation.end("error");
      return response;
    });
  }

  private async handleObservedRequest(
    req: Request,
    sourceIp: string | undefined,
    receiptId: string,
    receipt: ExecutionObservation,
  ): Promise<Response | null> {
    if (req.method !== "POST") {
      return null;
    }

    const url = new URL(req.url);
    const endpoint = this.endpoints.find((e) => e.route === url.pathname);
    if (!endpoint) {
      return null;
    }

    if (this.draining) return this.shuttingDownResponse(endpoint, sourceIp);

    this.emit({
      kind: "webhook_received",
      route: endpoint.route,
      workflowName: endpoint.workflowIdOrName,
    });

    const verifier = this.resolveHandler(endpoint);
    if (!verifier) {
      return this.handlerFailure(
        endpoint,
        "Webhook handler unavailable",
        sourceIp,
      );
    }

    for (const header of verifier.requiredHeaders) {
      if (!req.headers.get(header)) {
        this.emit({
          kind: "webhook_rejected",
          route: endpoint.route,
          workflowName: endpoint.workflowIdOrName,
          reason: `Missing ${header} header`,
          sourceIp,
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
        workflowName: endpoint.workflowIdOrName,
        reason: "Request body too large",
        sourceIp,
      });
      return Response.json(
        { error: "Request body too large" },
        { status: 413 },
      );
    }

    // Any verification failure (malformed value, stale timestamp, mismatch,
    // or a throwing extension verifier) returns a uniform 401 so the response
    // cannot be used as an oracle.
    let valid = false;
    try {
      valid = await verifier.verify(body, req.headers, endpoint.secret);
    } catch (error) {
      logger.warn("Webhook verifier threw on {route}: {error}", {
        route: endpoint.route,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (valid !== true) {
      this.emit({
        kind: "webhook_rejected",
        route: endpoint.route,
        workflowName: endpoint.workflowIdOrName,
        reason: "Invalid signature",
        sourceIp,
      });
      return Response.json(
        { error: "Invalid signature" },
        { status: 401 },
      );
    }

    const traceparent = req.headers.get("traceparent") ?? undefined;
    const tracestate = req.headers.get("tracestate") ?? undefined;
    const webhookPayload = buildWebhookPayload(
      body,
      req.headers,
      endpoint.route,
      verifier.signatureHeader,
    );

    // Extension hooks run only after successful verification, and only see
    // the redacted payload. Any failure is a generic 500 raised before the
    // run tracker or queue is touched.
    // ponytail: extension hooks run inline with no timeout — operator-installed
    // code; add an AbortSignal deadline if hung handlers become a problem.
    let serializedPayload: string;
    let customResponse: WebhookResponse | undefined;
    let httpResponse: Response | undefined;
    try {
      if (verifier.transform) {
        const transformed = await verifier.transform(
          webhookPayload.body,
          { ...webhookPayload.headers },
        );
        // Normalize through JSON so live and crash-replayed runs see the same
        // body; throws for BigInt/cyclic values.
        webhookPayload.body = JSON.parse(JSON.stringify(transformed ?? null));
      }
      serializedPayload = JSON.stringify(webhookPayload);
      customResponse = await verifier.respond?.(JSON.parse(serializedPayload));
      // Throws for a status outside 200–599 or a body on a null-body status.
      if (customResponse) httpResponse = toHttpResponse(customResponse);
    } catch (error) {
      logger.warn("Webhook handler hook failed on {route}: {error}", {
        route: endpoint.route,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.handlerFailure(endpoint, "Webhook handler failed", sourceIp);
    }

    if (httpResponse && !customResponse?.enqueue) return httpResponse;

    // Checked again: a drain can start during the awaits above, and a run
    // queued after it would be acknowledged and then aborted unreplayed.
    if (this.draining) return this.shuttingDownResponse(endpoint, sourceIp);

    // Queue the workflow run (with backpressure)
    if (this.runQueue.length >= MAX_QUEUE_DEPTH) {
      this.emit({
        kind: "webhook_rejected",
        route: endpoint.route,
        workflowName: endpoint.workflowIdOrName,
        reason: "Queue full",
        sourceIp,
      });
      return Response.json(
        { error: "Too many queued runs, try again later" },
        { status: 503 },
      );
    }

    let pendingRunId: string | undefined;
    let putPromise: Promise<void> | undefined;
    if (this.deps.runTracker) {
      pendingRunId = receiptId;
      const pendingEntry = {
        id: pendingRunId,
        receiptTrace: receipt.carrier,
        source: "webhook" as const,
        workflowIdOrName: endpoint.workflowIdOrName,
        payload: serializedPayload,
        route: endpoint.route,
        traceparent,
        tracestate,
        createdAt: new Date(this.now()).toISOString(),
      };
      this.deps.runTracker.enqueuePendingRun(pendingEntry);
      if (this.deps.controlPlaneStore) {
        putPromise = this.deps.controlPlaneStore.put(
          `pending-runs/${pendingRunId}`,
          new TextEncoder().encode(JSON.stringify(pendingEntry)),
        ).catch((err: unknown) => {
          logger.warn(
            "Control-plane dual-write failed for pending run {id}: {error}",
            {
              id: pendingRunId!,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        });
      }
    }

    this.runQueue.push({
      phaseStartedAt: performance.now(),
      lastProgressAt: new Date(this.now()).toISOString(),
      queueObservation: observeExecution("webhook.queue", {
        "swamp.webhook.receipt_id": receiptId,
      }, receipt.carrier),
      receiptId,
      receiptTrace: receipt.carrier,
      pendingRunId,
      putPromise,
      workflowIdOrName: endpoint.workflowIdOrName,
      route: endpoint.route,
      payload: webhookPayload,
      traceparent,
      tracestate,
      sourceIp,
      enqueuedAt: this.now(),
    });

    this.emit({
      kind: "webhook_queued",
      route: endpoint.route,
      workflowName: endpoint.workflowIdOrName,
    });

    this.processQueue();

    if (httpResponse) return httpResponse;
    return Response.json({
      status: "queued",
      workflow: endpoint.workflowIdOrName,
    });
  }

  private resolveHandler(
    endpoint: WebhookEndpoint,
  ): ReturnType<typeof resolveWebhookHandler> {
    try {
      return resolveWebhookHandler(endpoint.verifier);
    } catch (error) {
      logger.warn("Webhook handler creation failed on {route}: {error}", {
        route: endpoint.route,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private shuttingDownResponse(
    endpoint: WebhookEndpoint,
    sourceIp?: string,
  ): Response {
    this.emit({
      kind: "webhook_rejected",
      route: endpoint.route,
      workflowName: endpoint.workflowIdOrName,
      reason: "Server shutting down",
      sourceIp,
    });
    return Response.json(
      { error: "Server is shutting down, try again later" },
      {
        status: 503,
        headers: { "retry-after": String(SHUTDOWN_RETRY_AFTER_SECONDS) },
      },
    );
  }

  private handlerFailure(
    endpoint: WebhookEndpoint,
    reason: string,
    sourceIp?: string,
  ): Response {
    this.emit({
      kind: "webhook_rejected",
      route: endpoint.route,
      workflowName: endpoint.workflowIdOrName,
      reason,
      sourceIp,
    });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }

  enqueueForReplay(entry: {
    receiptTrace?: TraceCarrier;
    createdAt?: string;
    pendingRunId: string;
    workflowIdOrName: string;
    route: string;
    payload: WebhookPayload;
    traceparent?: string;
    tracestate?: string;
  }): void {
    // The pending entry stays in the run tracker for the next boot to replay.
    if (this.draining) return;
    const original = entry.createdAt ? Date.parse(entry.createdAt) : NaN;
    const receiptTrace = traceCarrier(entry.receiptTrace);
    this.runQueue.push({
      ...entry,
      phaseStartedAt: performance.now(),
      lastProgressAt: new Date(this.now()).toISOString(),
      receiptTrace,
      queueObservation: observeExecution("webhook.queue", {
        "swamp.webhook.receipt_id": entry.pendingRunId,
        "swamp.webhook.replayed": true,
      }, receiptTrace),
      receiptId: entry.pendingRunId,
      replayed: true,
      enqueuedAt: Number.isFinite(original) ? original : this.now(),
    });
    this.processQueue();
  }

  /**
   * Begin shutdown: reject new deliveries with 503, drop queued runs (their
   * run-tracker pending entries stay, so boot reconciliation replays them),
   * and wait up to `timeoutMs` for the in-flight runs to finish. A timeout
   * of 0 returns at once. Call {@link stop} afterwards to abort what is left.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.draining = true;
    // A dropped entry's control-plane write is what a replacement instance
    // replays, so it must land before shutdown moves on.
    const dropped = this.runQueue.splice(0);
    for (const entry of dropped) entry.queueObservation?.end("cancelled");
    await Promise.allSettled(dropped.map((entry) => entry.putPromise));
    if (timeoutMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.inFlight.keys()]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Gracefully stop: abort in-flight runs and wait for them to settle.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.runQueue) entry.queueObservation?.end("cancelled");
    this.runQueue.length = 0;
    for (const { controller } of this.running.values()) {
      controller.abort();
    }
    // Runs exit quickly after abort
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.keys()]);
    }
  }

  /**
   * Cancels an in-flight webhook run by its run id. Returns true if found and
   * aborted. `reason` becomes the run's `cancel_reason`.
   */
  cancelByRunId(runId: string, reason = "cancelled by user"): boolean {
    // An empty id would match every run whose start is not recorded yet.
    if (runId === "") return false;
    for (const entry of this.running.values()) {
      if (entry.runId === runId) {
        logger.info("Cancelling webhook run {runId}", { runId });
        entry.controller.abort(new Error(reason));
        return true;
      }
    }
    return false;
  }

  /**
   * Cancels every in-flight webhook run. Returns the number of runs cancelled.
   */
  cancelAllRuns(reason = "cancelled by user"): number {
    let count = 0;
    for (const entry of this.running.values()) {
      logger.info("Cancelling webhook run {runId}", { runId: entry.runId });
      entry.controller.abort(new Error(reason));
      count++;
    }
    return count;
  }

  /**
   * Starts queued entries, in arrival order, until `maxConcurrentRuns` are in
   * flight. Called on every enqueue and whenever a run settles.
   */
  private processQueue(): void {
    while (
      this.inFlight.size < this.maxConcurrentRuns && this.runQueue.length > 0
    ) {
      const entry = this.runQueue.shift()!;
      entry.admittedAt = performance.now();
      entry.phaseStartedAt = entry.admittedAt;
      entry.lastProgressAt = new Date(this.now()).toISOString();
      entry.queueObservation?.end("ok");
      // Detached: a launch from a request, from boot replay or from a
      // settling run must not carry that context's span into this run.
      const settled: Promise<void> = runDetached(() => this.runEntry(entry))
        .finally(() => {
          this.inFlight.delete(settled);
          try {
            this.processQueue();
          } catch (error) {
            logger.error("Webhook run queue stalled: {error}", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      this.inFlight.set(settled, entry);
    }
  }

  /** Never rejects: a failure is logged and the queue keeps going. */
  private async runEntry(entry: QueuedWebhookRun): Promise<void> {
    const observation = observeExecution(
      "webhook.run",
      {
        "swamp.webhook.receipt_id": entry.receiptId ?? entry.pendingRunId ??
          crypto.randomUUID(),
        "swamp.webhook.replayed": entry.replayed ?? false,
        "swamp.webhook.queue_wait_ms": Math.max(
          0,
          this.now() - entry.enqueuedAt,
        ),
      },
      undefined,
      entry.receiptTrace ? [entry.receiptTrace] : undefined,
    );
    try {
      const { pendingRunId, putPromise } = entry;
      if (putPromise) await putPromise;
      // A drain that began while this entry was dequeued leaves it pending
      // for the next boot to replay rather than starting it now.
      if (this.draining) {
        observation.end("cancelled");
        return;
      }
      if (pendingRunId && this.deps.runTracker) {
        this.deps.runTracker.deletePendingRun(pendingRunId);
        if (this.deps.controlPlaneStore) {
          await this.deps.controlPlaneStore.delete(
            `pending-runs/${pendingRunId}`,
          ).catch((err: unknown) => {
            logger.warn(
              "Control-plane delete failed for pending run {id}: {error}",
              {
                id: pendingRunId!,
                error: err instanceof Error ? err.message : String(err),
              },
            );
          });
        }
      }
      // Each entry starts outside any vault scope: the run enters its own
      // principal's scope, and the queue's inherited context never carries
      // another entry's (swamp-club#2676).
      await observation.run(() =>
        withoutVaultAccess(() => this.executeWorkflow(entry, observation))
      );
    } catch (error) {
      observation.end("error");
      logger.error(
        "Webhook run for workflow {workflow} on {route} did not start: {error}",
        {
          workflow: entry.workflowIdOrName,
          route: entry.route,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    } finally {
      observation.end("ok");
    }
  }

  private async executeWorkflow(
    entry: QueuedWebhookRun,
    observation: ExecutionObservation,
  ): Promise<void> {
    const { route, payload, traceparent, tracestate, sourceIp } = entry;
    const replayed = entry.replayed ?? false;
    const authorization = await this.authorize({
      workflowIdOrName: entry.workflowIdOrName,
      route,
      sourceIp,
      replayed,
    });
    if (!authorization.allowed) {
      observation.attributes({
        "swamp.webhook.rejection": "authorization_denied",
      });
      observation.end("error");
      const reason = authorization.reason ?? "denied";
      this.emit({
        kind: "webhook_denied",
        route,
        workflowName: entry.workflowIdOrName,
        reason,
        sourceIp,
        replayed,
      });
      const principal = this.deps.initiatedBy ?? "the webhook receiver";
      logger.warn(
        "Webhook run refused for {workflow} on {route} as {principal}: {reason}. Check with: swamp access check --subject {principal} --action run --on workflow:{workflow}",
        { workflow: entry.workflowIdOrName, route, principal, reason },
      );
      return;
    }
    // Events and bookkeeping keep the configured value, as before; only the
    // run executes the value authorization decided on.
    const { workflowIdOrName } = entry;

    const controller = new AbortController();
    const execId = crypto.randomUUID();
    // runId starts empty until the "started" event arrives with the real ID.
    // During this narrow window cancelByRunId() cannot match this run.
    const tracked = { controller, runId: "" };
    this.running.set(execId, tracked);
    // stop() may have swept `running` while this run was still dequeuing.
    if (this.stopped) controller.abort();
    let runId = "";

    try {
      let completedRun: WorkflowRunView | undefined;
      let streamError: string | undefined;
      let suspended = false;

      const execute = this.deps.executeWorkflow ?? executeWorkflowWithLocks;
      await execute(
        this.deps.repoDir,
        this.deps.repoContext,
        this.deps.datastoreConfig,
        {
          workflowIdOrName: authorization.workflowIdOrName,
          webhook: payload,
          traceparent,
          tracestate,
          instanceId: this.deps.instanceId,
          initiatedBy: this.deps.initiatedBy,
        },
        controller.signal,
        (event) => {
          // A nested workflow's started event carries the child's run id;
          // this webhook's run is the one without a parent.
          if (event.kind === "started" && event.parentRunId === undefined) {
            runId = event.runId;
            entry.runId = runId;
            entry.phaseStartedAt = performance.now();
            entry.lastProgressAt = new Date(this.now()).toISOString();
            observation.attributes({ "workflow.run_id": runId });
            tracked.runId = runId;
            // A route removed while this run was queued keeps no delay.
            if (this.endpoints.some((e) => e.route === route)) {
              this.lastQueueDelayMs.set(
                route,
                Math.max(0, this.now() - entry.enqueuedAt),
              );
            }
            this.emit({
              kind: "webhook_started",
              route,
              // The workflow authorization decided on, which is the one running.
              workflowName: authorization.workflowIdOrName,
              runId,
              sourceIp,
              replayed,
            });
            if (this.deps.controlPlaneStore && this.deps.instanceId) {
              writeActiveRun(
                this.deps.controlPlaneStore,
                this.deps.instanceId,
                runId,
                {
                  // The workflow the run resolved to, not the configured
                  // id-or-name, so cancel and attach authorize it.
                  resourceName: event.workflowName,
                  resourceId: authorization.workflowId,
                  runKind: "workflow-run",
                  startedAt: new Date().toISOString(),
                },
              );
            }
          }
          if (event.kind === "completed" || event.kind === "cancelled") {
            completedRun = event.run;
          }
          if (event.kind === "suspended") {
            suspended = true;
          }
          if (event.kind === "error") {
            streamError = event.error.message;
          }
        },
        this.deps.syncService,
        this.deps.runTracker,
        {
          syncGate: this.deps.syncGate,
          triggerSource: "webhook",
          initiatedBy: this.deps.initiatedBy,
          vaultAccess: this.deps.createVaultAccess?.(),
          defaultVault: this.deps.defaultVault,
        },
      );

      // Success requires an explicit "succeeded" status. A run that ends any
      // other way — a failed step, a cancellation, an error event carrying a
      // pre-run failure — must not be reported as a completion, because
      // webhook_completed feeds the "completed" bucket of the health
      // endpoint's throughput metrics.
      if (completedRun?.status === "succeeded") {
        observation.end("ok");
        this.emit({
          kind: "webhook_completed",
          route,
          workflowName: workflowIdOrName,
          runId,
        });
      } else if (suspended) {
        // A gated run has not finished: neither terminal event would be true,
        // so it contributes no health record until it resumes. Resumption
        // happens through the CLI, outside this service.
        logger.info(
          "Webhook workflow {workflow} suspended awaiting approval (run: {runId})",
          { workflow: workflowIdOrName, runId },
        );
      } else {
        const message = completedRun
          ? (completedRun.status === "cancelled"
            ? "workflow was cancelled"
            : extractFirstStepError(completedRun))
          : streamError ?? "workflow did not complete";
        observation.end(
          completedRun?.status === "cancelled" ? "cancelled" : "error",
        );
        this.emit({
          kind: "webhook_failed",
          route,
          workflowName: workflowIdOrName,
          error: message,
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        observation.end("cancelled");
        logger.info("Webhook workflow {workflow} aborted", {
          workflow: workflowIdOrName,
        });
        return;
      }

      observation.end("error");
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        kind: "webhook_failed",
        route,
        workflowName: workflowIdOrName,
        error: message,
      });
    } finally {
      this.running.delete(execId);
      if (runId && this.deps.controlPlaneStore && this.deps.instanceId) {
        deleteActiveRun(
          this.deps.controlPlaneStore,
          this.deps.instanceId,
          runId,
        );
      }
    }
  }

  /** Never throws: an authorizer failure refuses the run. */
  private async authorize(
    request: WebhookRunRequest,
  ): Promise<WebhookRunAuthorization> {
    if (!this.deps.authorizeRun) {
      return { allowed: true, workflowIdOrName: request.workflowIdOrName };
    }
    try {
      return await this.deps.authorizeRun(request);
    } catch (error) {
      return {
        allowed: false,
        workflowIdOrName: request.workflowIdOrName,
        reason: `authorization_error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  private emit(event: WebhookEvent): void {
    this.eventHandler?.(event);
  }
}
