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

// Compile-time sync check between this package's hand-duplicated wire
// protocol (./protocol.ts) and the server's source of truth
// (src/serve/protocol.ts).
//
// The duplication is deliberate — the client package must have zero
// dependencies on the CLI source tree so it can publish to JSR — but
// nothing cross-checked the two files, so they drifted silently. This
// test (a test file may cross the package boundary; only the published
// export graph must stay self-contained) makes drift a hard `deno check`
// error, in the style of integration/extension_kind_sync_test.ts.
//
// Three levels of check:
//   1. Same-named payload/frame types that are byte-equivalent today must
//      stay STRUCTURALLY IDENTICAL (mutually assignable + same key set —
//      the key-set check is what catches an added *optional* field, which
//      plain mutual assignability lets through).
//   2. Same-named types that already diverged are PINNED: the client type
//      must remain assignable to the serve type (safe to send), and the
//      divergence itself is pinned so that fixing it forces the pair to be
//      promoted to level 1 rather than passing silently.
//   3. The ServerRequest / ServerMessage unions are compared variant by
//      variant, with the exact set of known-divergent variants pinned.

import type * as client from "./protocol.ts";
import type * as serve from "../../src/serve/protocol.ts";

type MutuallyAssignable<A, B> = [A] extends [B] ? [B] extends [A] ? true
  : false
  : false;

type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A] ? true
  : false
  : false;

/** Mutually assignable AND the same property names (catches optional drift). */
type Identical<A, B> = MutuallyAssignable<A, B> extends true ? SameKeys<A, B>
  : false;

/** The client type can be sent where the serve type is expected. */
type ClientSendable<C, S> = [C] extends [S] ? true : false;

/** The keys of `T` whose value type is `false`. */
type FalseKeys<T extends Record<string, boolean>> = {
  [K in keyof T]: T[K] extends false ? K : never;
}[keyof T];

// ── 1. Structurally identical pairs ──────────────────────────────────────
//
// Every same-named type not listed in the divergence block below must be
// an exact structural copy of its serve counterpart. If an entry here
// fails to type-check, the two protocol files drifted: mirror the change
// into packages/client/protocol.ts (or, if the divergence is intentional,
// move the pair to the pinned block below with a comment).

const _identicalPairs: {
  DataGetPayload: Identical<client.DataGetPayload, serve.DataGetPayload>;
  DataQueryPayload: Identical<client.DataQueryPayload, serve.DataQueryPayload>;
  DataListPayload: Identical<client.DataListPayload, serve.DataListPayload>;
  DataSearchPayload: Identical<
    client.DataSearchPayload,
    serve.DataSearchPayload
  >;
  DataVersionsPayload: Identical<
    client.DataVersionsPayload,
    serve.DataVersionsPayload
  >;
  DataDeletePayload: Identical<
    client.DataDeletePayload,
    serve.DataDeletePayload
  >;
  DataRenamePayload: Identical<
    client.DataRenamePayload,
    serve.DataRenamePayload
  >;
  ModelGetPayload: Identical<client.ModelGetPayload, serve.ModelGetPayload>;
  ModelCreatePayload: Identical<
    client.ModelCreatePayload,
    serve.ModelCreatePayload
  >;
  ModelDeletePayload: Identical<
    client.ModelDeletePayload,
    serve.ModelDeletePayload
  >;
  ModelSearchPayload: Identical<
    client.ModelSearchPayload,
    serve.ModelSearchPayload
  >;
  ModelMethodDescribePayload: Identical<
    client.ModelMethodDescribePayload,
    serve.ModelMethodDescribePayload
  >;
  ModelOutputGetPayload: Identical<
    client.ModelOutputGetPayload,
    serve.ModelOutputGetPayload
  >;
  ModelOutputDataPayload: Identical<
    client.ModelOutputDataPayload,
    serve.ModelOutputDataPayload
  >;
  ModelOutputLogsPayload: Identical<
    client.ModelOutputLogsPayload,
    serve.ModelOutputLogsPayload
  >;
  ModelOutputSearchPayload: Identical<
    client.ModelOutputSearchPayload,
    serve.ModelOutputSearchPayload
  >;
  ModelMethodHistoryGetPayload: Identical<
    client.ModelMethodHistoryGetPayload,
    serve.ModelMethodHistoryGetPayload
  >;
  ModelMethodHistoryLogsPayload: Identical<
    client.ModelMethodHistoryLogsPayload,
    serve.ModelMethodHistoryLogsPayload
  >;
  ModelMethodHistorySearchPayload: Identical<
    client.ModelMethodHistorySearchPayload,
    serve.ModelMethodHistorySearchPayload
  >;
  ModelValidatePayload: Identical<
    client.ModelValidatePayload,
    serve.ModelValidatePayload
  >;
  ModelEvaluatePayload: Identical<
    client.ModelEvaluatePayload,
    serve.ModelEvaluatePayload
  >;
  WorkflowGetPayload: Identical<
    client.WorkflowGetPayload,
    serve.WorkflowGetPayload
  >;
  WorkflowSearchPayload: Identical<
    client.WorkflowSearchPayload,
    serve.WorkflowSearchPayload
  >;
  WorkflowHistoryGetPayload: Identical<
    client.WorkflowHistoryGetPayload,
    serve.WorkflowHistoryGetPayload
  >;
  WorkflowHistoryLogsPayload: Identical<
    client.WorkflowHistoryLogsPayload,
    serve.WorkflowHistoryLogsPayload
  >;
  WorkflowApprovePayload: Identical<
    client.WorkflowApprovePayload,
    serve.WorkflowApprovePayload
  >;
  WorkflowRejectPayload: Identical<
    client.WorkflowRejectPayload,
    serve.WorkflowRejectPayload
  >;
  VaultGetPayload: Identical<client.VaultGetPayload, serve.VaultGetPayload>;
  VaultPutPayload: Identical<client.VaultPutPayload, serve.VaultPutPayload>;
  VaultDeletePayload: Identical<
    client.VaultDeletePayload,
    serve.VaultDeletePayload
  >;
  VaultDescribePayload: Identical<
    client.VaultDescribePayload,
    serve.VaultDescribePayload
  >;
  VaultInspectPayload: Identical<
    client.VaultInspectPayload,
    serve.VaultInspectPayload
  >;
  VaultListKeysPayload: Identical<
    client.VaultListKeysPayload,
    serve.VaultListKeysPayload
  >;
  VaultSearchPayload: Identical<
    client.VaultSearchPayload,
    serve.VaultSearchPayload
  >;
  VaultAnnotatePayload: Identical<
    client.VaultAnnotatePayload,
    serve.VaultAnnotatePayload
  >;
  AuditTimelinePayload: Identical<
    client.AuditTimelinePayload,
    serve.AuditTimelinePayload
  >;
  SummarisePayload: Identical<client.SummarisePayload, serve.SummarisePayload>;
  ReportGetPayload: Identical<client.ReportGetPayload, serve.ReportGetPayload>;
  ReportSearchPayload: Identical<
    client.ReportSearchPayload,
    serve.ReportSearchPayload
  >;
  ReportDescribePayload: Identical<
    client.ReportDescribePayload,
    serve.ReportDescribePayload
  >;
  ReportTypeSearchPayload: Identical<
    client.ReportTypeSearchPayload,
    serve.ReportTypeSearchPayload
  >;
  ExtensionListPayload: Identical<
    client.ExtensionListPayload,
    serve.ExtensionListPayload
  >;
  ExtensionInfoPayload: Identical<
    client.ExtensionInfoPayload,
    serve.ExtensionInfoPayload
  >;
  ExtensionRmPayload: Identical<
    client.ExtensionRmPayload,
    serve.ExtensionRmPayload
  >;
  SerializedEvent: Identical<client.SerializedEvent, serve.SerializedEvent>;
  SerializedError: Identical<client.SerializedError, serve.SerializedError>;
} = {
  DataGetPayload: true,
  DataQueryPayload: true,
  DataListPayload: true,
  DataSearchPayload: true,
  DataVersionsPayload: true,
  DataDeletePayload: true,
  DataRenamePayload: true,
  ModelGetPayload: true,
  ModelCreatePayload: true,
  ModelDeletePayload: true,
  ModelSearchPayload: true,
  ModelMethodDescribePayload: true,
  ModelOutputGetPayload: true,
  ModelOutputDataPayload: true,
  ModelOutputLogsPayload: true,
  ModelOutputSearchPayload: true,
  ModelMethodHistoryGetPayload: true,
  ModelMethodHistoryLogsPayload: true,
  ModelMethodHistorySearchPayload: true,
  ModelValidatePayload: true,
  ModelEvaluatePayload: true,
  WorkflowGetPayload: true,
  WorkflowSearchPayload: true,
  WorkflowHistoryGetPayload: true,
  WorkflowHistoryLogsPayload: true,
  WorkflowApprovePayload: true,
  WorkflowRejectPayload: true,
  VaultGetPayload: true,
  VaultPutPayload: true,
  VaultDeletePayload: true,
  VaultDescribePayload: true,
  VaultInspectPayload: true,
  VaultListKeysPayload: true,
  VaultSearchPayload: true,
  VaultAnnotatePayload: true,
  AuditTimelinePayload: true,
  SummarisePayload: true,
  ReportGetPayload: true,
  ReportSearchPayload: true,
  ReportDescribePayload: true,
  ReportTypeSearchPayload: true,
  ExtensionListPayload: true,
  ExtensionInfoPayload: true,
  ExtensionRmPayload: true,
  SerializedEvent: true,
  SerializedError: true,
};
void _identicalPairs;

// ── 2. Known-divergent pairs (pinned) ────────────────────────────────────
//
// Each entry is [clientSendable, identical]. `clientSendable: true` proves
// the client type is still assignable to what the server accepts — the
// safety property. `identical: false` pins the divergence: when the client
// copy is brought back in sync, the pair must move up to the identical
// block, so a fix cannot land without being recorded here.

const _pinnedDivergentPairs: {
  // Serve added report/check skip filters and traceparent/tracestate;
  // the client copy has none of them (all optional — sendable).
  WorkflowRunPayload: [
    ClientSendable<client.WorkflowRunPayload, serve.WorkflowRunPayload>,
    Identical<client.WorkflowRunPayload, serve.WorkflowRunPayload>,
  ];
  // Serve added typeArg, definitionName, report/check skip filters and
  // trace context; the client copy has none of them (all optional).
  ModelMethodRunPayload: [
    ClientSendable<client.ModelMethodRunPayload, serve.ModelMethodRunPayload>,
    Identical<client.ModelMethodRunPayload, serve.ModelMethodRunPayload>,
  ];
  // Serve added an optional `inputs` filter the client copy lacks.
  WorkflowHistorySearchPayload: [
    ClientSendable<
      client.WorkflowHistorySearchPayload,
      serve.WorkflowHistorySearchPayload
    >,
    Identical<
      client.WorkflowHistorySearchPayload,
      serve.WorkflowHistorySearchPayload
    >,
  ];
  // Serve added an optional `inputs` filter the client copy lacks.
  WorkflowRunSearchPayload: [
    ClientSendable<
      client.WorkflowRunSearchPayload,
      serve.WorkflowRunSearchPayload
    >,
    Identical<
      client.WorkflowRunSearchPayload,
      serve.WorkflowRunSearchPayload
    >,
  ];
  // Serve relaxed workflowIdOrName to optional; the client still requires
  // it, which is narrower and therefore safe.
  WorkflowSchemaPayload: [
    ClientSendable<client.WorkflowSchemaPayload, serve.WorkflowSchemaPayload>,
    Identical<client.WorkflowSchemaPayload, serve.WorkflowSchemaPayload>,
  ];
  // Serve added optional traceparent/tracestate the client copy lacks.
  WorkflowResumePayload: [
    ClientSendable<client.WorkflowResumePayload, serve.WorkflowResumePayload>,
    Identical<client.WorkflowResumePayload, serve.WorkflowResumePayload>,
  ];
  // Serve widened platform/label/contentType/channel to string | string[];
  // the client's plain-string fields are a narrower, sendable subset.
  ExtensionSearchPayload: [
    ClientSendable<
      client.ExtensionSearchPayload,
      serve.ExtensionSearchPayload
    >,
    Identical<client.ExtensionSearchPayload, serve.ExtensionSearchPayload>,
  ];
  // Client declares limit/offset, which the server does not know about
  // (it accepts active/all) — extra optional fields are structurally
  // sendable but silently ignored, and the client cannot express `all`.
  RunHistoryPayload: [
    ClientSendable<client.RunHistoryPayload, serve.RunHistoryPayload>,
    Identical<client.RunHistoryPayload, serve.RunHistoryPayload>,
  ];
  // BUG (pinned, not endorsed): the client names the field
  // `workflowIdOrName` but the server's zod schema requires
  // `workflowName` — a request built from the client type is rejected.
  // Fixing packages/client/protocol.ts flips this to true and must
  // promote the pair to the identical block.
  WorkflowTriggerGetPayload: [
    ClientSendable<
      client.WorkflowTriggerGetPayload,
      serve.WorkflowTriggerGetPayload
    >,
    Identical<
      client.WorkflowTriggerGetPayload,
      serve.WorkflowTriggerGetPayload
    >,
  ];
} = {
  WorkflowRunPayload: [true, false],
  ModelMethodRunPayload: [true, false],
  WorkflowHistorySearchPayload: [true, false],
  WorkflowRunSearchPayload: [true, false],
  WorkflowSchemaPayload: [true, false],
  WorkflowResumePayload: [true, false],
  ExtensionSearchPayload: [true, false],
  RunHistoryPayload: [true, false],
  WorkflowTriggerGetPayload: [false, false],
};
void _pinnedDivergentPairs;

// Client-only types with no serve counterpart, intentionally excluded:
// DataResponse (client-side generic for the serve *Response family),
// WorkflowRunEvent / ModelMethodRunEvent / WorkflowRunView /
// ModelMethodRunView (wire shapes of libswamp domain events, which
// src/serve/protocol.ts does not re-declare).

// ── 3. Union variants, compared per discriminant ─────────────────────────

// Every request type-tag the client can emit must exist on the server.
const _requestTagsAreSubset: ClientSendable<
  client.ServerRequest["type"],
  serve.ServerRequest["type"]
> = true;
void _requestTagsAreSubset;

// Every message type-tag the client can parse must exist on the server.
const _messageTagsAreSubset: ClientSendable<
  client.ServerMessage["type"],
  serve.ServerMessage["type"]
> = true;
void _messageTagsAreSubset;

/** Per-variant assignability of the client union into the serve union. */
type RequestVariantCompat = {
  [K in client.ServerRequest["type"]]: ClientSendable<
    Extract<client.ServerRequest, { type: K }>,
    Extract<serve.ServerRequest, { type: K }>
  >;
};

type MessageVariantCompat = {
  [K in client.ServerMessage["type"]]: ClientSendable<
    Extract<client.ServerMessage, { type: K }>,
    Extract<serve.ServerMessage, { type: K }>
  >;
};

// The exact set of request variants that do NOT line up today. Pinned in
// both directions: a new divergence fails here, and a fixed one must be
// removed from the expected union.
//
//   workflow.trigger.get — the payload field-name bug pinned above.
const _divergentRequestVariants: MutuallyAssignable<
  FalseKeys<RequestVariantCompat>,
  "workflow.trigger.get"
> = true;
void _divergentRequestVariants;

// The exact set of message variants that do NOT line up today. The client
// declares the generic `DataResponse` ({ data: ... }) for these, but the
// server sends a differently-shaped payload:
//
//   server.version     — { version, gitSha }
//   access.grant.list  — AccessGrantListResponse { grants, ... }
//   access.group.list  — AccessGroupListResponse { groups }
//   access.check       — AccessCheckResponse { subject, action, ... }
//   access.can-i       — AccessCanIResponse { principal, decisions }
//   access.reload      — AccessReloadResponse { success, ... }
//   workflow.trigger.get — { data: WorkflowTriggerGetResult } (narrower
//                          than the client's Record<string, unknown>)
//   run.history        — RunHistoryResponse { runs }
//   cluster.instances  — ClusterInstancesResponse { instances }
//   serve.config       — ServeConfigResponse { config }
//
// A client switching on these frames sees a payload that does not match
// its declared type. Fixing packages/client/protocol.ts shrinks this
// union, and this pin forces the fix to be recorded.
const _divergentMessageVariants: MutuallyAssignable<
  FalseKeys<MessageVariantCompat>,
  | "server.version"
  | "access.grant.list"
  | "access.group.list"
  | "access.check"
  | "access.can-i"
  | "access.reload"
  | "workflow.trigger.get"
  | "run.history"
  | "cluster.instances"
  | "serve.config"
> = true;
void _divergentMessageVariants;

// A tiny runtime smoke test so this file registers in the test summary
// rather than passing as a silent no-op. The real assertions are the
// type-level constants above, enforced by `deno check`.
Deno.test("client protocol stays in sync with src/serve/protocol.ts (compile-time)", () => {
  // Intentionally trivial: reaching this line means the compile-time
  // checks above type-checked.
});
