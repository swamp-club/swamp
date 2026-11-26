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

import { assert, assertEquals } from "@std/assert";
import {
  serverRequestPayloadFields,
  serverRequestSchemas,
  validateServerRequest,
} from "./connection.ts";

const FEDERATION_TYPES = [
  "federation.member.list",
  "federation.member.get",
  "federation.member.remove",
  "federation.token.create",
  "federation.token.list",
  "federation.token.revoke",
];

// the request types a serve without a federation hub accepts; a change here
// changes what every serve accepts, gate off included
const NON_HUB_REQUEST_TYPES = [
  "access.can-i",
  "access.check",
  "access.delegation.end",
  "access.delegation.list",
  "access.grant.list",
  "access.group.list",
  "access.group.list-idp",
  "access.integration.list",
  "access.reload",
  "access.token.list",
  "access.token.mint",
  "access.token.reveal",
  "access.token.revoke",
  "access.token.rotate",
  "app.approve",
  "app.launch",
  "app.list",
  "app.revoke",
  "audit.alerts",
  "audit.export",
  "audit.query",
  "audit.report",
  "audit.rotate-key",
  "audit.subscribe",
  "audit.timeline",
  "audit.unsubscribe",
  "audit.verify",
  "cancel",
  "cluster.instances",
  "commits.head",
  "commits.subscribe",
  "data.delete",
  "data.gc",
  "data.get",
  "data.list",
  "data.prune",
  "data.query",
  "data.rename",
  "data.search",
  "data.subscribe",
  "data.versions",
  "datastore.claim",
  "datastore.namespace.list",
  "datastore.release",
  "datastore.setup.extension",
  "datastore.status",
  "doctor.datastores",
  "doctor.extensions",
  "doctor.secrets",
  "doctor.vaults",
  "doctor.workflows",
  "extension.info",
  "extension.install",
  "extension.list",
  "extension.outdated",
  "extension.pull",
  "extension.rm",
  "extension.search",
  "extension.update",
  "model.create",
  "model.delete",
  "model.edit",
  "model.evaluate",
  "model.get",
  "model.method.describe",
  "model.method.history.get",
  "model.method.history.logs",
  "model.method.history.search",
  "model.method.run",
  "model.output.data",
  "model.output.get",
  "model.output.logs",
  "model.output.search",
  "model.search",
  "model.type.describe",
  "model.type.search",
  "model.usage.summary",
  "model.validate",
  "report.describe",
  "report.get",
  "report.search",
  "report.type.search",
  "run.attach",
  "run.doctor",
  "run.gc",
  "run.history",
  "serve.config",
  "serve.reload",
  "server.version",
  "summarise",
  "vault.annotate",
  "vault.audit-trail",
  "vault.create",
  "vault.delete",
  "vault.describe",
  "vault.edit",
  "vault.get",
  "vault.inspect",
  "vault.list-keys",
  "vault.migrate",
  "vault.put",
  "vault.read-secret",
  "vault.search",
  "vault.type.search",
  "worker.lease.list",
  "worker.list",
  "worker.prune",
  "worker.queue.list",
  "worker.token.create",
  "worker.token.list",
  "worker.token.reveal",
  "worker.token.revoke",
  "worker.token.rotate",
  "worker.verify",
  "workflow.approvals",
  "workflow.approve",
  "workflow.cancel",
  "workflow.create",
  "workflow.delete",
  "workflow.edit",
  "workflow.evaluate",
  "workflow.get",
  "workflow.history.get",
  "workflow.history.logs",
  "workflow.history.search",
  "workflow.reject",
  "workflow.resume",
  "workflow.run",
  "workflow.run.search",
  "workflow.run.summary",
  "workflow.schedule.list",
  "workflow.schedule.pause",
  "workflow.schedule.resume",
  "workflow.schema",
  "workflow.search",
  "workflow.signal",
  "workflow.trigger.get",
  "workflow.trigger.remove",
  "workflow.trigger.set",
  "workflow.validate",
  "workflow.waits",
  "workspace.create",
  "workspace.delete",
  "workspace.get",
  "workspace.list",
  "workspace.resume",
  "workspace.sign-in",
  "workspace.suspend",
];

function sample(type: string): Record<string, unknown> {
  return {
    type,
    id: "request-1",
    payload: type.endsWith(".list") ? {} : { name: "edge-1" },
  };
}

Deno.test("serverRequestPayloadFields: without a hub, the request types are exactly those every serve accepted before federation", () => {
  assertEquals(
    [...serverRequestPayloadFields().keys()].sort(),
    NON_HUB_REQUEST_TYPES,
  );
  assertEquals(serverRequestSchemas().length, NON_HUB_REQUEST_TYPES.length);
  assertEquals(
    [...serverRequestPayloadFields({ federationHub: false }).keys()].sort(),
    NON_HUB_REQUEST_TYPES,
  );
});

Deno.test("serverRequestPayloadFields: a hub adds the federation request types and nothing else", () => {
  assertEquals(
    [...serverRequestPayloadFields({ federationHub: true }).keys()].sort(),
    [...NON_HUB_REQUEST_TYPES, ...FEDERATION_TYPES].sort(),
  );
  assertEquals(
    serverRequestSchemas({ federationHub: true }).length,
    NON_HUB_REQUEST_TYPES.length + FEDERATION_TYPES.length,
  );
});

Deno.test("validateServerRequest: without a hub, each federation type is refused with the same message as a made-up type", () => {
  const madeUp = validateServerRequest(sample("federation.made.up"));
  assertEquals(typeof madeUp, "string");
  for (const type of FEDERATION_TYPES) {
    assertEquals(validateServerRequest(sample(type)), madeUp, type);
    assertEquals(
      validateServerRequest(sample(type), { federationHub: false }),
      madeUp,
      type,
    );
  }
});

Deno.test("validateServerRequest: a hub accepts each federation type and still refuses a made-up one", () => {
  for (const type of FEDERATION_TYPES) {
    const validated = validateServerRequest(sample(type), {
      federationHub: true,
    });
    assert(typeof validated !== "string", `${type}: ${validated}`);
    assertEquals(validated.type, type);
  }
  assertEquals(
    typeof validateServerRequest(sample("federation.made.up"), {
      federationHub: true,
    }),
    "string",
  );
});

Deno.test("validateServerRequest: a hub bounds the federation payloads", () => {
  const scope = { federationHub: true };
  for (
    const payload of [
      {},
      { name: "" },
      { name: "x".repeat(65) },
      { name: "edge-1", durationMs: 1.5 },
      { name: "edge-1", durationMs: -1 },
    ]
  ) {
    assertEquals(
      typeof validateServerRequest(
        { type: "federation.token.create", id: "r", payload },
        scope,
      ),
      "string",
      JSON.stringify(payload),
    );
  }
});
