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

// compile-time sync check between the client's hand-duplicated wire protocol
// and src/serve/protocol.ts; the duplication keeps the published package free
// of CLI source dependencies

import type * as client from "./protocol.ts";
import type * as serve from "../../src/serve/protocol.ts";

type MutuallyAssignable<A, B> = [A] extends [B] ? [B] extends [A] ? true
  : false
  : false;

type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A] ? true
  : false
  : false;

type Identical<A, B> = MutuallyAssignable<A, B> extends true ? SameKeys<A, B>
  : false;

type ClientSendable<C, S> = [C] extends [S] ? true : false;

type FalseKeys<T extends Record<string, boolean>> = {
  [K in keyof T]: T[K] extends false ? K : never;
}[keyof T];

const _identicalPairs: {
  WorkflowRunPayload: Identical<
    client.WorkflowRunPayload,
    serve.WorkflowRunPayload
  >;
  ModelMethodRunPayload: Identical<
    client.ModelMethodRunPayload,
    serve.ModelMethodRunPayload
  >;
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
  ModelUsageSummaryPayload: Identical<
    client.ModelUsageSummaryPayload,
    serve.ModelUsageSummaryPayload
  >;
  ModelUsageSummaryRecentOutput: Identical<
    client.ModelUsageSummaryRecentOutput,
    serve.ModelUsageSummaryRecentOutput
  >;
  ModelUsageSummaryModel: Identical<
    client.ModelUsageSummaryModel,
    serve.ModelUsageSummaryModel
  >;
  ModelUsageSummaryData: Identical<
    client.ModelUsageSummaryData,
    serve.ModelUsageSummaryData
  >;
  ModelUsageSummaryResponse: Identical<
    client.ModelUsageSummaryResponse,
    serve.ModelUsageSummaryResponse
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
  WorkflowHistorySearchPayload: Identical<
    client.WorkflowHistorySearchPayload,
    serve.WorkflowHistorySearchPayload
  >;
  WorkflowRunSearchPayload: Identical<
    client.WorkflowRunSearchPayload,
    serve.WorkflowRunSearchPayload
  >;
  WorkflowRunSummaryPayload: Identical<
    client.WorkflowRunSummaryPayload,
    serve.WorkflowRunSummaryPayload
  >;
  WorkflowRunSummaryRecentRun: Identical<
    client.WorkflowRunSummaryRecentRun,
    serve.WorkflowRunSummaryRecentRun
  >;
  WorkflowRunSummaryWorkflow: Identical<
    client.WorkflowRunSummaryWorkflow,
    serve.WorkflowRunSummaryWorkflow
  >;
  WorkflowRunSummaryBucket: Identical<
    client.WorkflowRunSummaryBucket,
    serve.WorkflowRunSummaryBucket
  >;
  WorkflowRunSummaryData: Identical<
    client.WorkflowRunSummaryData,
    serve.WorkflowRunSummaryData
  >;
  WorkflowRunSummaryResponse: Identical<
    client.WorkflowRunSummaryResponse,
    serve.WorkflowRunSummaryResponse
  >;
  WorkflowSchemaPayload: Identical<
    client.WorkflowSchemaPayload,
    serve.WorkflowSchemaPayload
  >;
  WorkflowResumePayload: Identical<
    client.WorkflowResumePayload,
    serve.WorkflowResumePayload
  >;
  WorkflowApprovePayload: Identical<
    client.WorkflowApprovePayload,
    serve.WorkflowApprovePayload
  >;
  WorkflowRejectPayload: Identical<
    client.WorkflowRejectPayload,
    serve.WorkflowRejectPayload
  >;
  WorkflowCancelPayload: Identical<
    client.WorkflowCancelPayload,
    serve.WorkflowCancelPayload
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
  ExtensionSearchPayload: Identical<
    client.ExtensionSearchPayload,
    serve.ExtensionSearchPayload
  >;
  ExtensionInfoPayload: Identical<
    client.ExtensionInfoPayload,
    serve.ExtensionInfoPayload
  >;
  ExtensionRmPayload: Identical<
    client.ExtensionRmPayload,
    serve.ExtensionRmPayload
  >;
  RunHistoryPayload: Identical<
    client.RunHistoryPayload,
    serve.RunHistoryPayload
  >;
  WorkflowTriggerGetPayload: Identical<
    client.WorkflowTriggerGetPayload,
    serve.WorkflowTriggerGetPayload
  >;
  EffectiveTrigger: Identical<client.EffectiveTrigger, serve.EffectiveTrigger>;
  WorkflowTriggerGetResult: Identical<
    client.WorkflowTriggerGetResult,
    serve.WorkflowTriggerGetResult
  >;
  WorkflowTriggerGetResponse: Identical<
    client.WorkflowTriggerGetResponse,
    serve.WorkflowTriggerGetResponse
  >;
  AccessGrantListResponse: Identical<
    client.AccessGrantListResponse,
    serve.AccessGrantListResponse
  >;
  AccessGroupListResponse: Identical<
    client.AccessGroupListResponse,
    serve.AccessGroupListResponse
  >;
  AccessCheckResponse: Identical<
    client.AccessCheckResponse,
    serve.AccessCheckResponse
  >;
  AccessCanIDecision: Identical<
    client.AccessCanIDecision,
    serve.AccessCanIDecision
  >;
  AccessCanIResponse: Identical<
    client.AccessCanIResponse,
    serve.AccessCanIResponse
  >;
  AccessReloadFileResult: Identical<
    client.AccessReloadFileResult,
    serve.AccessReloadFileResult
  >;
  AccessReloadResponse: Identical<
    client.AccessReloadResponse,
    serve.AccessReloadResponse
  >;
  RunHistoryResponse: Identical<
    client.RunHistoryResponse,
    serve.RunHistoryResponse
  >;
  ClusterInstancesResponse: Identical<
    client.ClusterInstancesResponse,
    serve.ClusterInstancesResponse
  >;
  ServeConfigResponse: Identical<
    client.ServeConfigResponse,
    serve.ServeConfigResponse
  >;
  SerializedEvent: Identical<client.SerializedEvent, serve.SerializedEvent>;
  SerializedError: Identical<client.SerializedError, serve.SerializedError>;
} = {
  WorkflowRunPayload: true,
  ModelMethodRunPayload: true,
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
  ModelUsageSummaryPayload: true,
  ModelUsageSummaryRecentOutput: true,
  ModelUsageSummaryModel: true,
  ModelUsageSummaryData: true,
  ModelUsageSummaryResponse: true,
  ModelMethodHistoryGetPayload: true,
  ModelMethodHistoryLogsPayload: true,
  ModelMethodHistorySearchPayload: true,
  ModelValidatePayload: true,
  ModelEvaluatePayload: true,
  WorkflowGetPayload: true,
  WorkflowSearchPayload: true,
  WorkflowHistoryGetPayload: true,
  WorkflowHistoryLogsPayload: true,
  WorkflowHistorySearchPayload: true,
  WorkflowRunSearchPayload: true,
  WorkflowRunSummaryPayload: true,
  WorkflowRunSummaryRecentRun: true,
  WorkflowRunSummaryWorkflow: true,
  WorkflowRunSummaryBucket: true,
  WorkflowRunSummaryData: true,
  WorkflowRunSummaryResponse: true,
  WorkflowSchemaPayload: true,
  WorkflowResumePayload: true,
  WorkflowApprovePayload: true,
  WorkflowRejectPayload: true,
  WorkflowCancelPayload: true,
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
  ExtensionSearchPayload: true,
  ExtensionInfoPayload: true,
  ExtensionRmPayload: true,
  RunHistoryPayload: true,
  WorkflowTriggerGetPayload: true,
  EffectiveTrigger: true,
  WorkflowTriggerGetResult: true,
  WorkflowTriggerGetResponse: true,
  AccessGrantListResponse: true,
  AccessGroupListResponse: true,
  AccessCheckResponse: true,
  AccessCanIDecision: true,
  AccessCanIResponse: true,
  AccessReloadFileResult: true,
  AccessReloadResponse: true,
  RunHistoryResponse: true,
  ClusterInstancesResponse: true,
  ServeConfigResponse: true,
  SerializedEvent: true,
  SerializedError: true,
};
void _identicalPairs;

const _pinnedDivergentPairs: Record<never, [boolean, boolean]> = {};
void _pinnedDivergentPairs;

const _requestTagsAreSubset: ClientSendable<
  client.ServerRequest["type"],
  serve.ServerRequest["type"]
> = true;
void _requestTagsAreSubset;

const _messageTagsAreSubset: ClientSendable<
  client.ServerMessage["type"],
  serve.ServerMessage["type"]
> = true;
void _messageTagsAreSubset;

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

const _divergentRequestVariants: MutuallyAssignable<
  FalseKeys<RequestVariantCompat>,
  never
> = true;
void _divergentRequestVariants;

const _divergentMessageVariants: MutuallyAssignable<
  FalseKeys<MessageVariantCompat>,
  never
> = true;
void _divergentMessageVariants;

Deno.test("client protocol stays in sync with src/serve/protocol.ts (compile-time)", () => {
  // Intentionally trivial: reaching this line means the compile-time
  // checks above type-checked.
});
