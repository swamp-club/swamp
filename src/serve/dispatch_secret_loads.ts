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
 * The protected data-plane route a runner loads its dispatch's references
 * through (design/enablers/typed-secrets.md Section 9):
 *
 *   POST /data/secrets   load references of the dispatch's own bag
 *
 * Authenticated with the per-dispatch credential alone. Serve answers only
 * for references in the dispatch's bag, or held by a tagged sensitive field
 * of the dispatch's own resource (the resource claim, swamp-club#3529),
 * under the dispatching run's
 * vault access, and only while the attempt holds its lease: access is
 * checked again after the vault reads, so a read in flight when the
 * dispatch ends gets no value. Every reply is `no-store`, errors name the
 * code and the reference and never a value, and serve audit records only
 * metadata.
 */

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { UnifiedDataRepository } from "../domain/data/repositories.ts";
import {
  DISPATCH_SECRETS_PATH,
  type DispatchSecretLoadRefusal,
  type DispatchSecretLoadRefusalBody,
  type DispatchSecretLoadRequest,
  DispatchSecretLoadRequestSchema,
  type DispatchSecretLoadResponse,
  MAX_DISPATCH_SECRET_LOAD_BODY_BYTES,
} from "../domain/remote/protocol.ts";
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditOutcome } from "../domain/serve_audit/audit_event.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import { SecretRedactor } from "../domain/secrets/secret_redactor.ts";
import { parseUntrusted } from "../domain/untrusted_parse.ts";
import {
  runWithVaultAccess,
  VaultAccessDeniedError,
} from "../domain/vaults/run_vault_access.ts";
import type { VaultService } from "../domain/vaults/vault_service.ts";
import {
  assertSecretKeyNotDenied,
  assertVaultNotDenied,
  ResourceClaimRefusedError,
  ResourceClaimVerifier,
} from "./dispatch_secret_authorization.ts";
import {
  type ActiveDispatch,
  bagReferenceId,
  type DispatchRegistry,
} from "./dispatch_registry.ts";

const logger = getSwampLogger(["serve", "data-plane", "secrets"]);

const VERB = "loadSecrets";

/** The serve audit action of the route's events. */
export const DISPATCH_SECRET_LOAD_AUDIT_ACTION = "worker.secrets.load";

/** Where the route's audit events go, once serve has an emitter. */
export interface DispatchSecretLoadsAudit {
  emitter: AuditEmitter;
  instanceId: string;
  /**
   * True while serve audit runs fail-secure and cannot durably record
   * events, as every other audited request checks, so the route refuses
   * rather than serve a value whose audit event may be lost.
   */
  refuseRequests?: () => boolean;
}

export interface DispatchSecretLoadsOptions {
  sessions: {
    verify(
      credential: string,
    ): { workerId: string; dispatchId?: string } | null;
  };
  dispatches: DispatchRegistry;
  vault: () => Promise<VaultService>;
  /** The repository holding a dispatch's records, for resource claims. */
  repoFor: (dispatch: ActiveDispatch) => UnifiedDataRepository;
  /** Read per request, since serve creates its emitter after the data plane. */
  audit?: () => DispatchSecretLoadsAudit | undefined;
}

/** The authenticated caller of one load request. */
export interface DispatchSecretLoadCaller {
  workerName: string;
  dispatchId: string;
}

/** Runs a request's work in the dispatch's trace (the data plane's span). */
export type DispatchSecretLoadTrace = (
  caller: DispatchSecretLoadCaller,
  fn: () => Promise<Response>,
) => Promise<Response>;

/** Whether `segments` (a data-plane path split on `/`) name this route. */
export function isDispatchSecretsRoute(segments: readonly string[]): boolean {
  return `/${segments.join("/")}` === DISPATCH_SECRETS_PATH;
}

interface Reply {
  response: Response;
  outcome: AuditOutcome;
  code?: DispatchSecretLoadRefusal;
  count: number;
}

function noStore(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function refusal(
  status: number,
  code: DispatchSecretLoadRefusal,
  error: string,
  count: number,
  reference?: { vaultName: string; key: string },
): Reply {
  const body: DispatchSecretLoadRefusalBody = {
    error,
    code,
    ...(reference
      ? { reference: { vaultName: reference.vaultName, key: reference.key } }
      : {}),
  };
  const outcome: AuditOutcome = status === 401 || status === 403 ||
      status === 410
    ? "denied"
    : "failure";
  return { response: noStore(body, status), outcome, code, count };
}

/**
 * Reads `req`'s body, or null when it is longer than `limit` bytes. Stops
 * reading at the limit, so an oversized body is never held whole.
 */
async function readBounded(
  req: Request,
  limit: number,
): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await req.body?.cancel();
    return null;
  }
  if (req.body === null) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export class DispatchSecretLoads {
  readonly #options: DispatchSecretLoadsOptions;
  readonly #claims: ResourceClaimVerifier;

  constructor(options: DispatchSecretLoadsOptions) {
    this.#options = options;
    this.#claims = new ResourceClaimVerifier({
      verb: VERB,
      repoFor: options.repoFor,
    });
  }

  /** Answers one request to the route. Never throws. */
  async handle(
    req: Request,
    sourceIp: string,
    trace: DispatchSecretLoadTrace,
  ): Promise<Response> {
    // Serve's own id, never the worker's: the emitter drops a success event
    // whose id it saw denied, so a worker reusing one could hide its loads.
    const requestId = crypto.randomUUID();
    const audit = this.#options.audit?.();
    let caller: DispatchSecretLoadCaller | null = null;
    let reply: Reply;
    try {
      const credential = req.headers.get("authorization")?.match(
        /^Bearer (.+)$/,
      )?.[1];
      const verified = credential === undefined
        ? null
        : this.#options.sessions.verify(credential);
      if (verified?.dispatchId !== undefined) {
        caller = {
          workerName: verified.workerId,
          dispatchId: verified.dispatchId,
        };
      }
      if (caller === null || credential === undefined) {
        reply = refusal(
          401,
          "unauthenticated",
          "Missing or invalid dispatch credential",
          0,
        );
      } else if (req.method !== "POST") {
        reply = refusal(405, "malformed_request", "Use POST", 0);
      } else if (audit?.refuseRequests?.() === true) {
        reply = refusal(
          503,
          "audit_unavailable",
          "Request rejected: audit subsystem cannot durably record events (fail-secure mode)",
          0,
        );
      } else {
        const authenticated = caller;
        let traced: Reply | undefined;
        await trace(authenticated, async () => {
          traced = await this.#load(req, credential, authenticated);
          return traced.response;
        });
        reply = traced!;
      }
    } catch (error) {
      logger.error(
        "Dispatch secret load {requestId} for dispatch {dispatchId} failed: {errorName}",
        {
          requestId,
          dispatchId: caller?.dispatchId ?? "unknown",
          errorName: error instanceof Error ? error.name : typeof error,
        },
      );
      reply = refusal(500, "internal_error", "Internal server error", 0);
    }
    this.#audit(audit, requestId, sourceIp, caller, reply);
    return reply.response;
  }

  async #load(
    req: Request,
    credential: string,
    caller: DispatchSecretLoadCaller,
  ): Promise<Reply> {
    const dispatch = this.#options.dispatches.forDispatch(
      caller.workerName,
      caller.dispatchId,
    );
    if (dispatch === null) {
      return refusal(410, "access_ended", "The dispatch has ended", 0);
    }
    const body = await readBounded(req, MAX_DISPATCH_SECRET_LOAD_BODY_BYTES);
    if (body === null) {
      return refusal(
        413,
        "request_too_large",
        `The request body exceeds ${MAX_DISPATCH_SECRET_LOAD_BODY_BYTES} bytes`,
        0,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return refusal(400, "malformed_request", "The body is not JSON", 0);
    }
    // Untrusted input: a refusal costs the same however large it is
    // (swamp-club#3862).
    const parsed = parseUntrusted(DispatchSecretLoadRequestSchema, raw);
    if (!parsed.success) {
      return refusal(
        400,
        "malformed_request",
        "The body is not a load request",
        0,
      );
    }
    const references = parsed.data.references;
    const count = references.length;
    const refused = await this.#authorize(dispatch, references);
    if (refused !== null) return refused;

    // The run's vault scope holds the reads, as the same read in-process
    // would be (swamp-club#2676). A run with none reads unscoped, as
    // resolveSecret does. The data plane's trace applies the same scope;
    // applying it here too keeps the route held to it whatever runs it, and
    // nesting the same scope changes nothing.
    const scope = dispatch.vaultAccess;
    const read = () => this.#read(dispatch, references);
    const loaded = await (scope ? runWithVaultAccess(scope, read) : read());
    if (!Array.isArray(loaded)) return loaded;

    // Access ends with the dispatch's credential and its registration, and
    // either can end while the reads ran: answer only if both still hold.
    if (!this.#stillHolds(credential, dispatch)) {
      logger.info(
        "Dispatch {dispatchId} ended during a secret load; no value returned",
        { dispatchId: dispatch.dispatchId },
      );
      return refusal(410, "access_ended", "The dispatch has ended", count);
    }
    // Serve is about to deliver these values to the dispatch, so its
    // redactor must know them before the reply leaves, as for resolveSecret
    // (swamp-club#3527).
    const redactor = dispatch.redactor ??= new SecretRedactor();
    for (const { value } of loaded) redactor.addSecret(value);
    const response: DispatchSecretLoadResponse = { values: loaded };
    return { response: noStore(response, 200), outcome: "success", count };
  }

  /**
   * Refuses the request when any reference is reserved, or neither in the
   * dispatch's bag nor admitted by a verified resource claim. All or
   * nothing: one refused reference returns no value for the others.
   */
  async #authorize(
    dispatch: ActiveDispatch,
    references: DispatchSecretLoadRequest["references"],
  ): Promise<Reply | null> {
    const count = references.length;
    for (const reference of references) {
      const { vaultName, key } = reference;
      try {
        assertVaultNotDenied(vaultName, VERB);
        assertSecretKeyNotDenied(key, VERB);
      } catch (error) {
        return refusal(
          403,
          "reserved_secret",
          (error as Error).message,
          count,
          reference,
        );
      }
      if (dispatch.bagReferences?.has(bagReferenceId(vaultName, key))) {
        continue;
      }
      if (reference.resource === undefined) {
        return refusal(
          403,
          "not_in_dispatch",
          `${VERB}: secret '${key}' of vault '${vaultName}' is not in the dispatch's secret bag`,
          count,
          reference,
        );
      }
      try {
        await this.#claims.verify(
          dispatch,
          reference.resource,
          vaultName,
          key,
        );
      } catch (error) {
        if (error instanceof ResourceClaimRefusedError) {
          return refusal(
            403,
            "resource_claim_refused",
            error.message,
            count,
            reference,
          );
        }
        throw error;
      }
    }
    return null;
  }

  /** Reads each distinct reference once, in order of first occurrence. */
  async #read(
    dispatch: ActiveDispatch,
    references: DispatchSecretLoadRequest["references"],
  ): Promise<DispatchSecretLoadResponse["values"] | Reply> {
    const vault = await this.#options.vault();
    const values: DispatchSecretLoadResponse["values"] = [];
    const seen = new Set<string>();
    for (const reference of references) {
      const { vaultName, key } = reference;
      const id = bagReferenceId(vaultName, key);
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const value = await vault.get(
          vaultName,
          key,
          `serve:${dispatch.workerName}`,
        );
        values.push({ vaultName, key, value });
      } catch (error) {
        if (error instanceof VaultAccessDeniedError) {
          return refusal(
            403,
            "vault_access_denied",
            `${VERB}: the run's vault access does not allow secret '${key}' of vault '${vaultName}'`,
            references.length,
            reference,
          );
        }
        // A provider's message is not echoed or logged: nothing bounds what
        // it may hold.
        logger.warn(
          "Vault read for dispatch {dispatchId} failed: {vaultName} {key}: {errorName}",
          {
            dispatchId: dispatch.dispatchId,
            vaultName,
            key,
            errorName: error instanceof Error ? error.name : typeof error,
          },
        );
        return refusal(
          500,
          "vault_error",
          `${VERB}: reading secret '${key}' of vault '${vaultName}' failed`,
          references.length,
          reference,
        );
      }
    }
    return values;
  }

  #stillHolds(credential: string, dispatch: ActiveDispatch): boolean {
    const verified = this.#options.sessions.verify(credential);
    return verified !== null &&
      verified.workerId === dispatch.workerName &&
      verified.dispatchId === dispatch.dispatchId &&
      this.#options.dispatches.forDispatch(
          dispatch.workerName,
          dispatch.dispatchId,
        ) === dispatch;
  }

  /** One metadata-only event per request, at every audit level. */
  #audit(
    audit: DispatchSecretLoadsAudit | undefined,
    requestId: string,
    sourceIp: string,
    caller: DispatchSecretLoadCaller | null,
    reply: Reply,
  ): void {
    if (audit === undefined) return;
    audit.emitter.emit(buildAuditEvent({
      instanceId: audit.instanceId,
      category: "secrets",
      stage: "response",
      outcome: reply.outcome,
      action: DISPATCH_SECRET_LOAD_AUDIT_ACTION,
      resourceKind: "dispatch",
      resourceName: caller?.dispatchId ?? "unknown",
      principalKind: caller ? "worker" : "anonymous",
      principalId: caller?.workerName ?? "anonymous",
      initiatedBy: caller ? `worker:${caller.workerName}` : "ghost",
      sourceIp,
      requestId,
      detail: `${reply.code ?? "loaded"}; references=${reply.count}`,
    }));
  }
}
