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
 * Which WebSocket requests a serve follower refuses in team mode
 * (swamp-club#4096), before its handler runs: every request that writes,
 * runs work or changes serve's own state. A run refused only at its first
 * commit would already have run its steps' side effects. Reads are answered
 * from the follower's copy while it is fresh. The commit-time refusal stays
 * the backstop for any write this list misses.
 *
 * `integration/serve_follower_requests_rules_test.ts` pins that every
 * request type serve dispatches is in exactly one of the two lists.
 *
 * @module
 */

import {
  type ServeLeader,
  ServeNotLeaderError,
} from "../domain/datastore_v3/serve_leader.ts";
import { CONFIRMED_WRITE_REQUESTS } from "./write_confirmation.ts";

/** The requests a follower refuses: writes, runs and serve state changes. */
export const FOLLOWER_REFUSED_REQUESTS: ReadonlySet<string> = new Set([
  ...CONFIRMED_WRITE_REQUESTS,
  // Writes outside the commit log, or whose reply confirms them itself.
  "vault.put",
  "workflow.signal",
  "workflow.trigger.set",
  "workflow.trigger.remove",
  "workflow.schedule.pause",
  "workflow.schedule.resume",
  "datastore.claim",
  "datastore.release",
  "datastore.setup.extension",
  "worker.verify",
  "model.evaluate",
  "workflow.evaluate",
  "doctor.datastores",
  "doctor.vaults",
  "doctor.secrets",
  "doctor.workflows",
  "doctor.extensions",
  "serve.reload",
  "audit.rotate-key",
]);

/** The requests a follower answers from its own copy. */
export const FOLLOWER_READ_REQUESTS: ReadonlySet<string> = new Set([
  "server.version",
  "access.grant.list",
  "access.group.list",
  "access.group.list-idp",
  "access.check",
  "access.can-i",
  "data.get",
  "data.query",
  "data.list",
  "data.search",
  "data.versions",
  "model.search",
  "model.method.describe",
  "workflow.search",
  "workflow.approvals",
  "vault.get",
  "audit.timeline",
  "audit.query",
  "audit.verify",
  "audit.export",
  "audit.subscribe",
  "audit.unsubscribe",
  "audit.alerts",
  "audit.report",
  "summarise",
  "report.get",
  "report.search",
  "report.describe",
  "report.type.search",
  "model.get",
  "model.output.get",
  "model.output.data",
  "model.output.logs",
  "model.output.search",
  "model.method.history.get",
  "model.method.history.logs",
  "model.method.history.search",
  "model.validate",
  "workflow.get",
  "workflow.history.get",
  "workflow.history.logs",
  "workflow.history.search",
  "workflow.run.search",
  "workflow.run.summary",
  "workflow.schema",
  "workflow.waits",
  "vault.describe",
  "vault.inspect",
  "vault.search",
  "vault.list-keys",
  "vault.audit-trail",
  "vault.read-secret",
  "worker.list",
  "worker.queue.list",
  "worker.lease.list",
  "datastore.status",
  "extension.list",
  "extension.search",
  "extension.info",
  "extension.outdated",
  "run.history",
  "run.attach",
  "access.token.list",
  "model.type.describe",
  "model.type.search",
  "workflow.validate",
  "workflow.trigger.get",
  "workflow.schedule.list",
  "vault.type.search",
  "worker.token.list",
  "datastore.namespace.list",
  "cluster.instances",
  "serve.config",
]);

/**
 * The reply an HTTP route serve answers outside the WebSocket gives a
 * request a follower refuses (swamp-club#4096): a retryable 503 with
 * `Retry-After` and the leader, as the datastore API's. Called once the
 * caller is authenticated, so only a caller learns which node leads.
 */
export function followerHttpRefusal(
  type: string,
  gate: FollowerGate | undefined,
): Response | undefined {
  const refusal = followerRefusal(type, gate);
  if (refusal === undefined) return undefined;
  return Response.json(
    {
      code: refusal.code,
      message: refusal.message,
      ...(refusal.leader !== undefined ? { leader: refusal.leader } : {}),
    },
    { status: 503, headers: { "Retry-After": "5" } },
  );
}

/** Serve's role, as a request gate needs it. */
export interface FollowerGate {
  readonly role: "leader" | "follower";
  leader(): ServeLeader | undefined;
  isStale(): boolean;
}

/**
 * The refusal a request of `type` meets on this node, if any: a write on a
 * follower, or any request on a follower whose copy is too old to read.
 */
export function followerRefusal(
  type: string,
  gate: FollowerGate | undefined,
): ServeNotLeaderError | undefined {
  if (gate === undefined || gate.role === "leader") return undefined;
  if (!FOLLOWER_READ_REQUESTS.has(type)) {
    return new ServeNotLeaderError(gate.leader());
  }
  // The version handshake answers whatever the copy's age.
  if (type !== "server.version" && gate.isStale()) {
    return new ServeNotLeaderError(gate.leader(), true);
  }
  return undefined;
}
