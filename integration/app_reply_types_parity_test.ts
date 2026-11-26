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

import { assertEquals } from "@std/assert";
import type * as client from "../packages/client/protocol.ts";
import {
  ALWAYS_ALLOWED_REQUESTS,
  CAPABILITY_REQUESTS,
} from "../packages/app-sdk/capabilities.ts";
import type * as serve from "../src/serve/protocol.ts";
import type { RunKind } from "../src/serve/active_run_registry.ts";
import type { DataGetData } from "../src/libswamp/data/get.ts";
import type { DataQueryData } from "../src/libswamp/data/query.ts";
import type { DataSearchData } from "../src/libswamp/data/search.ts";
import type { DataVersionsData } from "../src/libswamp/data/versions.ts";
import type { ModelGetData } from "../src/libswamp/models/get.ts";
import type { ModelSearchData } from "../src/libswamp/models/search.ts";
import type { ModelOutputSearchData } from "../src/libswamp/models/output_search.ts";
import type { ModelUsageSummaryData } from "../src/libswamp/models/usage_summary.ts";
import type { WorkflowGetData } from "../src/libswamp/workflows/get.ts";
import type { WorkflowSearchData } from "../src/libswamp/workflows/search.ts";
import type { WorkflowRunSearchEvent } from "../src/libswamp/workflows/run_search.ts";
import type { WorkflowHistorySearchData } from "../src/libswamp/workflows/history_search.ts";
import type { WorkflowRunSummaryData } from "../src/libswamp/workflows/run_summary.ts";
import type { WorkflowRunView } from "../src/libswamp/workflows/workflow_run_view.ts";
import type { WorkflowHistoryLogsCompletedData } from "../src/libswamp/workflows/history_logs.ts";
import type { WorkerListData } from "../src/libswamp/worker/list.ts";
import type {
  AppLaunchData as LibAppLaunchData,
  AppListData as LibAppListData,
  AppSummary,
} from "../src/libswamp/apps/apps.ts";
import type {
  AppEntry,
  AppLaunchReply,
  AppListReply,
} from "../packages/dashboard/src/apps/app_types.ts";
import { RunEventBuffer } from "../src/serve/run_event_buffer.ts";

// identity, not assignability: an optional field added on either side fails
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

type Assignable<From, To> = [From] extends [To] ? true : false;

type PayloadOf<F> = F extends { payload?: unknown } ? F["payload"] : never;

type ServeRequestPayload<K extends string> = PayloadOf<
  Extract<serve.ServerRequest, { type: K }>
>;

type ServeMessagePayload<K extends string> = PayloadOf<
  Extract<serve.ServerMessage, { type: K }>
>;

type Flat<T> = { [K in keyof T]: T[K] };

type RunSearchCompleted = Omit<
  Extract<WorkflowRunSearchEvent, { kind: "completed" }>,
  "kind"
>;

const _replies: {
  dataGet: Same<client.DataGetReply["data"], DataGetData>;
  dataQuery: Same<client.DataQueryReply["data"], DataQueryData>;
  dataSearch: Same<client.DataSearchReply["data"], DataSearchData>;
  dataVersions: Same<client.DataVersionsReply["data"], DataVersionsData>;
  modelGet: Same<client.ModelGetReply["data"], ModelGetData>;
  modelSearch: Same<client.ModelSearchReply["data"], ModelSearchData>;
  modelOutputSearch: Same<
    client.ModelOutputSearchReply["data"],
    ModelOutputSearchData
  >;
  // the client's existing copy types triggeredBy as string, wider than serve's
  modelUsageSummary: Assignable<
    ModelUsageSummaryData,
    client.ModelUsageSummaryReply["data"]
  >;
  workflowGet: Same<client.WorkflowGetReply["data"], WorkflowGetData>;
  // serve sends the page with the total paginate counted
  workflowSearch: Same<
    client.WorkflowSearchReply,
    { data: WorkflowSearchData; total: number }
  >;
  workflowRunSearch: Same<client.WorkflowRunSearchReply, RunSearchCompleted>;
  workflowHistorySearch: Same<
    client.WorkflowHistorySearchReply["data"],
    WorkflowHistorySearchData
  >;
  workflowRunSummary: Same<
    Omit<client.WorkflowRunSummaryReply["data"], "totals">,
    Omit<WorkflowRunSummaryData, "totals">
  >;
  // serve builds totals as an intersection, which identity tells from a flat copy
  workflowRunSummaryTotals: Same<
    client.WorkflowRunSummaryReply["data"]["totals"],
    Flat<WorkflowRunSummaryData["totals"]>
  >;
  workflowHistoryGet: Same<
    client.WorkflowHistoryGetReply["data"],
    WorkflowRunView
  >;
  workflowHistoryLogs: Same<
    client.WorkflowHistoryLogsReply["data"],
    WorkflowHistoryLogsCompletedData
  >;
  workerList: Same<client.WorkerListReply["data"], WorkerListData>;
  federationMemberList: Same<
    client.FederationMemberListReply,
    ServeMessagePayload<"federation.member.list">
  >;
  federationMemberGet: Same<
    client.FederationMemberGetReply,
    ServeMessagePayload<"federation.member.get">
  >;
  serverVersion: Same<
    client.ServerVersionReply,
    ServeMessagePayload<"server.version">
  >;
} = {
  dataGet: true,
  dataQuery: true,
  dataSearch: true,
  dataVersions: true,
  modelGet: true,
  modelSearch: true,
  modelOutputSearch: true,
  modelUsageSummary: true,
  workflowGet: true,
  workflowSearch: true,
  workflowRunSearch: true,
  workflowHistorySearch: true,
  workflowRunSummary: true,
  workflowRunSummaryTotals: true,
  workflowHistoryGet: true,
  workflowHistoryLogs: true,
  workerList: true,
  federationMemberList: true,
  federationMemberGet: true,
  serverVersion: true,
};

const _runAttach: {
  payload: Same<client.RunAttachPayload, serve.RunAttachPayload>;
  kind: Same<client.RunAttachKind, RunKind>;
  // serve's frame types kind as string; the registry's RunKind is narrower
  attached: Assignable<
    client.RunAttachedReply,
    ServeMessagePayload<"run.attached">
  >;
  elsewhere: Same<
    client.RunElsewhereReply,
    ServeMessagePayload<"run.elsewhere">
  >;
  interrupted: Same<
    client.RunInterruptedReply,
    ServeMessagePayload<"run.interrupted">
  >;
} = {
  payload: true,
  kind: true,
  attached: true,
  elsewhere: true,
  interrupted: true,
};

const _dataSubscribe: {
  payload: Same<client.DataSubscribePayload, serve.DataSubscribePayload>;
  frame: Same<client.DataSubscribeFrame, ServeMessagePayload<"data.subscribe">>;
  change: Same<client.DataChange, serve.DataChange>;
} = { payload: true, frame: true, change: true };

const _runRequests: {
  modelMethodRun: Same<
    client.ModelMethodRunPayload,
    serve.ModelMethodRunPayload
  >;
  modelMethodRunRequest: Same<
    client.ModelMethodRunPayload,
    ServeRequestPayload<"model.method.run">
  >;
  // an app pins the behavior type it runs; a client without it cannot
  expectedType: Same<
    client.ModelMethodRunPayload["expectedType"],
    serve.ModelMethodRunPayload["expectedType"]
  >;
  workflowRun: Same<client.WorkflowRunPayload, serve.WorkflowRunPayload>;
  workflowRunRequest: Same<
    client.WorkflowRunPayload,
    ServeRequestPayload<"workflow.run">
  >;
} = {
  modelMethodRun: true,
  modelMethodRunRequest: true,
  expectedType: true,
  workflowRun: true,
  workflowRunRequest: true,
};

// serve types an event loosely, so its stamp is pinned at runtime below
const _runEventStamp: {
  keys: Same<keyof client.RunEventStamp, "seq" | "at">;
  attachEvent: Same<
    Pick<client.RunAttachEvent, keyof client.RunEventStamp>,
    { seq: number; at?: string }
  >;
} = { keys: true, attachEvent: true };

// the dashboard, serve and libswamp each declare the app list; readonly aside
type Writable<T> = T extends readonly (infer U)[] ? Writable<U>[]
  : T extends object ? { -readonly [K in keyof T]: Writable<T[K]> }
  : T;

const _apps: {
  listEntry: Same<Writable<AppSummary>, Writable<serve.AppListEntry>>;
  listData: Same<Writable<LibAppListData>, Writable<serve.AppListData>>;
  launch: Same<Writable<LibAppLaunchData>, Writable<serve.AppLaunchData>>;
  dashboardEntry: Same<Writable<AppEntry>, Writable<serve.AppListEntry>>;
  dashboardList: Same<Writable<AppListReply>, Writable<serve.AppListResponse>>;
  dashboardLaunch: Same<
    Writable<AppLaunchReply>,
    Writable<serve.AppLaunchData>
  >;
} = {
  listEntry: true,
  listData: true,
  launch: true,
  dashboardEntry: true,
  dashboardList: true,
  dashboardLaunch: true,
};

type PayloadParity = {
  [K in client.AppRequestType]: Same<
    client.AppRequestMap[K]["payload"],
    ServeRequestPayload<K>
  >;
};

type FalseKeys<T> = { [K in keyof T]: T[K] extends true ? never : K }[keyof T];

const _payloads: Same<FalseKeys<PayloadParity>, never> = true;

// a key missing here, or one the map lacks, fails to compile
const APP_REQUEST_TYPES: Record<client.AppRequestType, true> = {
  "workflow.run.search": true,
  "workflow.run.summary": true,
  "workflow.history.get": true,
  "workflow.history.logs": true,
  "workflow.history.search": true,
  "model.usage.summary": true,
  "data.get": true,
  "data.query": true,
  "data.search": true,
  "data.versions": true,
  "model.output.search": true,
  "workflow.search": true,
  "workflow.get": true,
  "model.search": true,
  "model.get": true,
  "worker.list": true,
  "federation.member.list": true,
  "federation.member.get": true,
  "server.version": true,
};

// streams answer with frames: RunAttachFrame/RunAttachEvent for an attach, DataSubscribeFrame pages for a subscription
const APP_STREAM_REQUESTS = ["data.subscribe", "run.attach"];

Deno.test("app reply types: every client reply type matches what serve sends", () => {
  void _replies;
  void _runAttach;
  void _dataSubscribe;
  void _payloads;
  void _runRequests;
  void _runEventStamp;
  void _apps;
});

Deno.test("app reply types: serve stamps every run event with the RunEventStamp fields", () => {
  const at = new Date("2026-01-02T03:04:05.000Z");
  const buffer = new RunEventBuffer(8, { now: () => at });
  buffer.push({ kind: "started" });
  const seen: { seq: number; event: Record<string, unknown> }[] = [];
  buffer.subscribe(
    {
      onEvent: (seq, event) => seen.push({ seq, event }),
      onTerminal: () => {},
      onDetach: () => {},
    },
    0,
  );
  assertEquals(seen.length, 1);
  const stamp: Required<client.RunEventStamp> = {
    seq: seen[0].seq,
    at: seen[0].event.at as string,
  };
  assertEquals(stamp, { seq: 1, at: at.toISOString() });
});

Deno.test("app reply types: the request map covers exactly the requests an app may make", () => {
  const allowed = [
    ...Object.values(CAPABILITY_REQUESTS).flat(),
    ...ALWAYS_ALLOWED_REQUESTS,
  ].sort();
  assertEquals(
    [...Object.keys(APP_REQUEST_TYPES), ...APP_STREAM_REQUESTS].sort(),
    allowed,
  );
});
