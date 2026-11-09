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

// A compile-time check that the HTTP wire types copied into ./http_protocol.ts
// still match serve's; the code lists are compared at runtime in
// integration/client_http_protocol_sync_test.ts.

import type * as client from "./http_protocol.ts";
import type * as routes from "../../src/serve/delegation_routes.ts";
import type * as reply from "../../src/serve/http_action_reply.ts";
import type * as serve from "../../src/serve/protocol.ts";
import type { RefreshRefusalReason } from "../../src/domain/access/delegation.ts";
import type { PendingApproval } from "../../src/libswamp/workflows/approvals.ts";
import type { ExpiredApproval } from "../../src/libswamp/workflows/approvals.ts";
import type { WorkflowApproveData } from "../../src/libswamp/workflows/approve.ts";
import type { WorkflowRejectData } from "../../src/libswamp/workflows/reject.ts";

type MutuallyAssignable<A, B> = [A] extends [B] ? [B] extends [A] ? true
  : false
  : false;

type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A] ? true
  : false
  : false;

type Identical<A, B> = MutuallyAssignable<A, B> extends true ? SameKeys<A, B>
  : false;

/** what serve sends can be read as the client's narrower copy */
type Readable<S, C> = [S] extends [C] ? true : false;

type Check<T extends true> = T;

export type HttpProtocolSync = [
  Check<Identical<client.LinkStartedBody, routes.LinkStartedBody>>,
  Check<Identical<client.LinkPersonBody, routes.LinkPersonBody>>,
  Check<Identical<client.TokensIssuedBody, routes.TokensIssuedBody>>,
  Check<Identical<client.RedeemBody, routes.RedeemBody>>,
  Check<Identical<client.RefreshedBody, routes.RefreshedBody>>,
  Check<Identical<client.EndedBody, routes.EndedBody>>,
  Check<Identical<client.DelegationFailureBody, routes.DelegationFailureBody>>,
  Check<Identical<client.DelegationRouteCode, routes.DelegationRouteCode>>,
  Check<Identical<client.RefreshRefusalReason, RefreshRefusalReason>>,
  Check<Identical<client.ActionSuccessBody, reply.ActionSuccessBody>>,
  Check<Identical<client.ActionStartedData, reply.ActionStartedData>>,
  Check<Identical<client.ActionFailureBody, reply.ActionFailureBody>>,
  Check<Readable<PendingApproval, client.PendingApproval>>,
  Check<Readable<ExpiredApproval, client.ExpiredApproval>>,
  Check<Readable<WorkflowApproveData, client.ApproveData>>,
  Check<Readable<WorkflowRejectData, client.RejectData>>,
  Check<
    Readable<serve.WorkflowSignalResponseData, client.SignalDeliveredData>
  >,
  Check<
    Readable<serve.WorkflowSignalPendingResponseData, client.SignalPendingData>
  >,
  Check<
    Readable<
      serve.WorkflowSignalAcceptedResponseData,
      client.SignalAcceptedData
    >
  >,
];

Deno.test("client HTTP protocol stays in sync with serve (compile-time)", () => {
  // the checks above fail deno check; nothing to do at runtime
});
