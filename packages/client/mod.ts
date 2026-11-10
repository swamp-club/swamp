// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and\/or modify
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
// along with Swamp.  If not, see <https:\/\/www.gnu.org\/licenses\/>.

/**
 * @swamp-club/swamp-lib — TypeScript client for swamp serve: the WebSocket API,
 * and the bearer-only HTTP routes an integration uses to act for a person.
 *
 * ## WebSocket
 *
 * ```typescript
 * import { SwampClient } from "@swamp-club/swamp-lib";
 *
 * const client = new SwampClient("ws://localhost:9090");
 * await client.connect();
 *
 * // Callback-based: settles when the run completes, is cancelled, or
 * // suspends at a gate; narrow on `outcome` before reading the run
 * const result = await client.workflowRun(
 *   { workflowIdOrName: "my-workflow", inputs: { env: "dev" } },
 *   { started: (e) => console.log(`Run ${e.runId} started`) },
 * );
 * if (result.outcome === "suspended") {
 *   console.log(`Waiting at ${result.gate.stepId}: ${result.gate.prompt}`);
 *   // after the gate is approved, continue the same run
 *   await client.workflowResume({
 *     workflowIdOrName: "my-workflow",
 *     runId: result.id,
 *   });
 * } else if (result.outcome !== "replayed") {
 *   console.log(`Run ${result.id} ended ${result.status}`);
 * }
 *
 * // AsyncIterable-based: for-await-of event stream
 * for await (const event of client.workflowRunStream({ workflowIdOrName: "my-workflow" })) {
 *   console.log(event.kind);
 * }
 *
 * client.close();
 * ```
 *
 * ## Acting for a person over HTTP
 *
 * An integration an operator registered links a person once, then acts for
 * them within its ceiling. Deno only. These clients refuse to run in a browser:
 * they hold bearer credentials.
 *
 * ```typescript
 * import {
 *   DelegatedTokens,
 *   memoryTokenStore,
 *   SwampActionClient,
 *   SwampIntegrationClient,
 * } from "@swamp-club/swamp-lib";
 *
 * const serve = "https://serve.example.com";
 * const integration = new SwampIntegrationClient(serve, {
 *   credential: Deno.env.get("SWAMP_INTEGRATION_CREDENTIAL")!,
 * });
 *
 * // 1. Link: show consentUrl only to the person, then poll at `interval`
 * const link = await integration.startLink({
 *   external: {
 *     platform: "slack",
 *     teamId: "T1",
 *     userId: "U1",
 *     display: "pat",
 *     workspace: "acme",
 *   },
 *   ceiling: {
 *     version: 1,
 *     ceiling: [{ actions: ["run", "read"], resource: "workflow:deploy" }],
 *   },
 * });
 * let redeemed = await integration.redeemLink(link);
 * while (redeemed.kind === "pending") {
 *   await new Promise((r) => setTimeout(r, redeemed.intervalSeconds * 1000));
 *   redeemed = await integration.redeemLink(link);
 * }
 * if (redeemed.kind !== "issued") throw new Error(`not linked: ${redeemed.kind}`);
 *
 * // 2. Keep the tokens: any store with load and save will do, shared by any
 * //    number of copies of the app, because the refresh token never changes
 * const store = memoryTokenStore();
 * await store.save(redeemed.tokens.delegationId, redeemed.tokens);
 * const tokens = new DelegatedTokens({
 *   integration,
 *   store,
 *   delegationId: redeemed.tokens.delegationId,
 * });
 *
 * // 3. Act: the access token is refreshed before it expires and after a 401
 * const actions = new SwampActionClient(serve, { token: tokens });
 * const started = await actions.run({
 *   workflowIdOrName: "deploy",
 *   idempotencyKey: "slack-interaction-1234", // from the user's action
 * });
 * switch (started.kind) {
 *   case "started":
 *   case "replayed": // the same key again: no second run
 *     console.log(started.runId);
 *     break;
 *   case "outcome_unknown": // read history before acting again
 *   case "refused":
 *   case "not_found":
 *   case "idempotency_conflict":
 *     break;
 * }
 *
 * // A gate decision names the attempt the person saw, so a stale button
 * // records nothing (gate_reopened)
 * const { approvals } = await actions.approvals();
 * const gate = approvals[0];
 * if (gate?.suspendedAt) {
 *   await actions.approve({
 *     workflowIdOrName: gate.workflowName,
 *     runId: gate.runId,
 *     stepName: gate.stepName,
 *     suspendedAt: gate.suspendedAt,
 *   });
 * }
 * ```
 *
 * A call throws `SwampHttpError` for anything that isn't one of its outcomes.
 * `error.code === "link_ended"` means the person has to link again;
 * `"not_admitted"` means serve refuses them for now and the link works again
 * once they are admitted; `"link_suspended"` likewise, until swamp-club
 * vouches for the link again. `"consent_required"` means the person hasn't
 * consented to that action: start a new link asking for everything the app
 * needs, and the existing link carries on under the same delegation once they
 * consent. Calls are retried only where nothing can happen
 * twice: a start with its key and reads, after a lost reply; any call serve
 * refused before acting. Every call takes an `AbortSignal` and has a timeout.
 *
 * Tokens and credentials never appear in an error's message, its JSON or the
 * clients' printed form.
 *
 * @module
 */

export { SwampClient } from "./client.ts";
export type { SwampClientOptions } from "./client.ts";

// Protocol types
export type {
  CascadedNestedRunData,
  DataGetPayload,
  DataListPayload,
  DataQueryPayload,
  DataResponse,
  DataSearchPayload,
  DetachedNestedRunData,
  FanOutGatePrompt,
  ModelMethodRunEvent,
  ModelMethodRunPayload,
  ModelMethodRunView,
  ModelSearchPayload,
  NestedSignalWaitData,
  RunHistoryPayload,
  SerializedError,
  SerializedEvent,
  ServerMessage,
  ServerRequest,
  SkippedSupersedeData,
  SuspendedGate,
  WorkflowResumePayload,
  WorkflowRunEvent,
  WorkflowRunJobInfo,
  WorkflowRunPayload,
  WorkflowRunResult,
  WorkflowRunSearchPayload,
  WorkflowRunView,
  WorkflowSearchPayload,
} from "./protocol.ts";

// HTTP: integrations acting for a person
export { SwampActionClient } from "./action_client.ts";
export type {
  ApproveOutcome,
  HistoryOutcome,
  OutcomeUnknown,
  Refused,
  RejectOutcome,
  ResumeOutcome,
  SignalOutcome,
  StartOutcome,
  SwampActionClientOptions,
} from "./action_client.ts";
export { SwampIntegrationClient } from "./integration_client.ts";
export type {
  CallOptions,
  DelegatedTokenSet,
  RedeemOutcome,
  RefreshOutcome,
  StartLinkInput,
  SwampIntegrationClientOptions,
} from "./integration_client.ts";
export { DelegatedTokens, fixedToken } from "./delegated_tokens.ts";
export type {
  DelegatedTokensOptions,
  TokenEvent,
  TokenSource,
} from "./delegated_tokens.ts";
export { memoryTokenStore } from "./token_store.ts";
export type { TokenStore } from "./token_store.ts";
export { scrubSecrets, SwampHttpError } from "./http_errors.ts";
export type { SwampHttpErrorInit } from "./http_errors.ts";
export type { HttpClientOptions } from "./http_transport.ts";
export type {
  ApprovalsData,
  ApproveData,
  CeilingDocument,
  DecisionActionPayload,
  ExpiredApproval,
  HistoryData,
  HttpActionType,
  LinkPersonBody,
  LinkStartedBody,
  PendingApproval,
  RefreshRefusalReason,
  RejectData,
  ResumeActionPayload,
  RunActionPayload,
  SignalAcceptedData,
  SignalActionPayload,
  SignalDeliveredData,
  SignalPendingData,
  SignalReceipt,
} from "./http_protocol.ts";

// Stream helpers
export {
  consumeStream,
  type EventHandlers,
  type HasTerminals,
  result,
  type StreamEvent,
  SwampClientError,
  withDefaults,
} from "./stream.ts";
