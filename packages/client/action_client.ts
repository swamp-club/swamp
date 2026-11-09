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

import type { TokenSource } from "./delegated_tokens.ts";
import { fixedToken } from "./delegated_tokens.ts";
import {
  type ApprovalsData,
  type ApproveData,
  type DecisionActionPayload,
  type HistoryData,
  HTTP_ACTION_PATH,
  type HttpActionType,
  type RejectData,
  type ResumeActionPayload,
  type RunActionPayload,
  type SignalAcceptedData,
  type SignalActionPayload,
  type SignalDeliveredData,
  type SignalPendingData,
} from "./http_protocol.ts";
import {
  errorFrom,
  type HttpClientOptions,
  type HttpReply,
  HttpTransport,
  outcomeUnknown,
  refusedBeforeActing,
  refuseInBrowser,
} from "./http_transport.ts";
import type { CallOptions } from "./integration_client.ts";

// serve answers still_working after 30 s
const DEFAULT_TIMEOUT_MS = 35_000;

export interface SwampActionClientOptions extends HttpClientOptions {
  /** a person's DelegatedTokens, or a fixed bearer token */
  token: TokenSource | string;
}

/** serve may or may not have acted; read status before acting again */
export interface OutcomeUnknown {
  kind: "outcome_unknown";
  requestId?: string;
}

export interface Refused {
  kind: "refused";
  message: string;
}

export type StartOutcome =
  | { kind: "started"; runId: string; workflowName: string }
  | { kind: "replayed"; runId: string; workflowName: string }
  | Refused
  | { kind: "not_found" }
  | { kind: "idempotency_conflict" }
  | OutcomeUnknown;

export type ResumeOutcome =
  | { kind: "started"; runId: string; workflowName: string }
  | { kind: "replayed"; runId: string; workflowName: string }
  | { kind: "not_suspended" }
  | { kind: "not_resumable"; message: string }
  | Refused
  | { kind: "not_found" }
  | OutcomeUnknown;

export type HistoryOutcome =
  | { kind: "found"; run: HistoryData }
  | { kind: "not_found" };

type GateRefusal =
  | { kind: "already_decided" }
  /** the gate expired or closed */
  | { kind: "gate_closed" }
  /** the step is not waiting for a decision */
  | { kind: "gate_not_open" }
  /** the gate was asked again since suspendedAt; read approvals and decide again */
  | { kind: "gate_reopened" }
  /** the step name is in more than one job; pass jobName */
  | { kind: "ambiguous_gate" };

export type ApproveOutcome =
  | { kind: "decided"; decision: ApproveData }
  | GateRefusal
  | Refused
  | { kind: "not_found" }
  | OutcomeUnknown;

export type RejectOutcome =
  | { kind: "decided"; decision: RejectData }
  | GateRefusal
  | Refused
  | { kind: "not_found" }
  | OutcomeUnknown;

export type SignalOutcome =
  | { kind: "delivered"; data: SignalDeliveredData }
  | { kind: "pending"; data: SignalPendingData }
  | { kind: "accepted"; data: SignalAcceptedData }
  | { kind: "not_found" }
  | { kind: "invalid_payload"; errors: string[] }
  | {
    kind:
      | "already_settled"
      | "already_pending"
      | "no_open_wait"
      | "expired"
      | "closed";
    message: string;
  }
  | OutcomeUnknown;

/** serve codes this client turns into outcomes or retries, kept in step by test */
export const ACTION_OUTCOME_CODES = [
  "forbidden",
  "not_found",
  "idempotency_conflict",
  "run_not_suspended",
  "run_not_resumable",
  "already_decided",
  "gate_closed",
  "gate_not_open",
  "gate_reopened",
  "ambiguous_gate",
  "invalid_payload",
  "already_settled",
  "already_pending",
  "no_open_wait",
  "expired",
  "closed",
  "outcome_unknown",
  "still_working",
  "busy",
  "type_not_allowed",
] as const;

const GATE_CODES = new Set([
  "already_decided",
  "gate_closed",
  "gate_not_open",
  "gate_reopened",
  "ambiguous_gate",
]);

const SIGNAL_REFUSALS = new Set([
  "already_settled",
  "already_pending",
  "no_open_wait",
  "expired",
  "closed",
]);

/**
 * serve's workflow actions over HTTP, acting as the person whose token it
 * holds; replies come back as outcomes, and anything else throws SwampHttpError
 */
export class SwampActionClient {
  readonly #transport: HttpTransport;
  readonly #tokens: TokenSource;

  constructor(url: string, options: SwampActionClientOptions) {
    refuseInBrowser("SwampActionClient");
    this.#transport = new HttpTransport(url, DEFAULT_TIMEOUT_MS, options);
    this.#tokens = typeof options.token === "string"
      ? fixedToken(options.token)
      : options.token;
  }

  /**
   * starts a run; the same idempotencyKey replays rather than starting another,
   * so it should come from the user's action, never be made up on a retry
   */
  async run(
    payload: RunActionPayload,
    options: CallOptions = {},
  ): Promise<StartOutcome> {
    const reply = await this.#send("workflow.run", payload, options, true);
    const started = startedOf(reply);
    if (started) return started;
    return common(reply) as StartOutcome ??
      (reply.code === "idempotency_conflict"
        ? { kind: "idempotency_conflict" }
        : thrown(reply, "workflow.run"));
  }

  /** continues a suspended run; not retried once it may have started */
  async resume(
    payload: ResumeActionPayload,
    options: CallOptions = {},
  ): Promise<ResumeOutcome> {
    const reply = await this.#send("workflow.resume", payload, options, false);
    const started = startedOf(reply);
    if (started) return started;
    if (reply.code === "run_not_suspended") return { kind: "not_suspended" };
    if (reply.code === "run_not_resumable") {
      return { kind: "not_resumable", message: messageOf(reply) };
    }
    return common(reply) as ResumeOutcome ??
      thrown(reply, "workflow.resume");
  }

  /** a run's status and steps, for polling a run this client started */
  async history(
    runId: string,
    options: CallOptions = {},
  ): Promise<HistoryOutcome> {
    const reply = await this.#send(
      "workflow.history.get",
      { runId },
      options,
      true,
    );
    if (reply.status === 200) {
      return { kind: "found", run: reply.body.data as HistoryData };
    }
    if (reply.code === "not_found") return { kind: "not_found" };
    return thrown(reply, "workflow.history.get");
  }

  /**
   * gates waiting for a decision that the caller may read; rows carry no
   * jobName, so an ambiguous_gate answer needs the job named another way
   */
  async approvals(options: CallOptions = {}): Promise<ApprovalsData> {
    const reply = await this.#send("workflow.approvals", {}, options, true);
    if (reply.status === 200) return reply.body.data as ApprovalsData;
    return thrown(reply, "workflow.approvals");
  }

  /** suspendedAt is the attempt the caller saw, so a stale button records nothing */
  async approve(
    payload: DecisionActionPayload,
    options: CallOptions = {},
  ): Promise<ApproveOutcome> {
    return await this.#decide(
      "workflow.approve",
      payload,
      options,
    ) as ApproveOutcome;
  }

  async reject(
    payload: DecisionActionPayload,
    options: CallOptions = {},
  ): Promise<RejectOutcome> {
    return await this.#decide(
      "workflow.reject",
      payload,
      options,
    ) as RejectOutcome;
  }

  /** with an idempotencyKey a retry is answered by the first signal's receipt */
  async signal(
    payload: SignalActionPayload,
    options: CallOptions = {},
  ): Promise<SignalOutcome> {
    const reply = await this.#send(
      "workflow.signal",
      payload,
      options,
      payload.idempotencyKey !== undefined,
    );
    const data = reply.body.data as Record<string, unknown> | undefined;
    if (reply.status === 200) {
      return {
        kind: "delivered",
        data: data as unknown as SignalDeliveredData,
      };
    }
    if (reply.status === 202 && data?.pending !== undefined) {
      return { kind: "pending", data: data.pending as SignalPendingData };
    }
    if (reply.status === 202 && data?.accepted !== undefined) {
      return { kind: "accepted", data: data.accepted as SignalAcceptedData };
    }
    if (reply.code === "invalid_payload") {
      return {
        kind: "invalid_payload",
        errors: Array.isArray(reply.body.errors)
          ? reply.body.errors.map(String)
          : [],
      };
    }
    if (reply.code !== undefined && SIGNAL_REFUSALS.has(reply.code)) {
      return {
        kind: reply.code as
          | "already_settled"
          | "already_pending"
          | "no_open_wait"
          | "expired"
          | "closed",
        message: messageOf(reply),
      };
    }
    if (reply.code === "not_found") return { kind: "not_found" };
    if (outcomeUnknown(reply)) return unknownOf(reply);
    return thrown(reply, "workflow.signal");
  }

  async #decide(
    type: "workflow.approve" | "workflow.reject",
    payload: DecisionActionPayload,
    options: CallOptions,
  ): Promise<ApproveOutcome | RejectOutcome> {
    const reply = await this.#send(type, payload, options, false);
    if (reply.status === 200) {
      return { kind: "decided", decision: reply.body.data as ApproveData };
    }
    if (reply.code !== undefined && GATE_CODES.has(reply.code)) {
      return { kind: reply.code } as GateRefusal;
    }
    return common(reply) as ApproveOutcome ?? thrown(reply, type);
  }

  /**
   * sends with the current access token; a 401 is refused before serve acts,
   * so after one refresh the call is sent once more whatever its type
   */
  async #send(
    type: HttpActionType,
    payload: unknown,
    options: CallOptions,
    sendsTwiceSafely: boolean,
  ): Promise<HttpReply> {
    const retry = (reply: HttpReply) =>
      refusedBeforeActing(reply) || (sendsTwiceSafely && outcomeUnknown(reply));
    const post = (bearer: string) =>
      this.#transport.post(HTTP_ACTION_PATH, bearer, { type, payload }, {
        route: "action",
        actionType: type,
        retry,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    const bearer = await this.#tokens.accessToken(options);
    const reply = await post(bearer);
    if (reply.status !== 401) return reply;
    return await post(await this.#tokens.unauthorized(bearer, options));
  }

  toJSON(): Record<string, unknown> {
    return { client: "SwampActionClient", token: "[redacted]" };
  }

  [Symbol.for("Deno.customInspect")](): string {
    return "SwampActionClient { token: [redacted] }";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "SwampActionClient { token: [redacted] }";
  }
}

function messageOf(reply: HttpReply): string {
  return typeof reply.body.message === "string" ? reply.body.message : "";
}

function startedOf(
  reply: HttpReply,
):
  | { kind: "started" | "replayed"; runId: string; workflowName: string }
  | undefined {
  if (reply.status !== 202) return undefined;
  const data = reply.body.data as Record<string, unknown> | undefined;
  if (typeof data?.runId !== "string") return undefined;
  return {
    kind: data.replayed === true ? "replayed" : "started",
    runId: data.runId,
    workflowName: String(data.workflowName),
  };
}

function unknownOf(reply: HttpReply): OutcomeUnknown {
  return {
    kind: "outcome_unknown",
    ...(typeof reply.body.requestId === "string"
      ? { requestId: reply.body.requestId }
      : {}),
  };
}

/** outcomes every acting call shares, or undefined for the caller to map */
function common(
  reply: HttpReply,
): Refused | { kind: "not_found" } | OutcomeUnknown | undefined {
  if (reply.code === "forbidden") {
    return { kind: "refused", message: messageOf(reply) };
  }
  if (reply.code === "not_found") return { kind: "not_found" };
  if (outcomeUnknown(reply)) return unknownOf(reply);
  return undefined;
}

function thrown(reply: HttpReply, type: HttpActionType): never {
  if (reply.code === "type_not_allowed") {
    throw errorFrom(
      { ...reply, code: "action_unavailable" },
      "action",
      type,
    );
  }
  throw errorFrom(reply, "action", type);
}
