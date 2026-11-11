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
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../domain/serve_audit/audit_event.ts";
import {
  emitServeConfigNotLanded,
  emitServeConfigReloaded,
  SERVE_CONFIG_RELOADED_ACTION,
  serveConfigReloadedDetail,
} from "./serve_config_reload_audit.ts";

function recorder(): { events: AuditEvent[]; emitter: AuditEmitter } {
  const events: AuditEvent[] = [];
  return {
    events,
    emitter: {
      emit: (event: AuditEvent) => events.push(event),
    } as unknown as AuditEmitter,
  };
}

const report = {
  applied: ["dashboard", "audit.fail-open"],
  needsRestart: [{ setting: "port", reason: "the listener is bound to it" }],
  overridden: [{ setting: "queue-timeout", by: "--queue-timeout" }],
};

Deno.test("serveConfigReloadedDetail: names the settings by group, never a value", () => {
  assertEquals(
    serveConfigReloadedDetail("reload", report),
    "trigger=reload applied=dashboard,audit.fail-open needs-restart=port overridden=queue-timeout",
  );
  assertEquals(
    serveConfigReloadedDetail("signal", {
      applied: [],
      needsRestart: [],
      overridden: [],
    }),
    "trigger=signal",
  );
});

Deno.test("emitServeConfigReloaded: a reload over the socket names its caller and client", () => {
  const { events, emitter } = recorder();
  emitServeConfigReloaded(
    { auditEmitter: emitter, instanceId: "inst-1" },
    {
      trigger: "reload",
      principal: { kind: "user", id: "alice" },
      client: "cli",
      sourceIp: "10.0.0.5",
    },
    report,
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].action, SERVE_CONFIG_RELOADED_ACTION);
  assertEquals(events[0].category, "admin");
  assertEquals(events[0].principalId, "alice");
  assertEquals(events[0].client, "cli");
  assertEquals(events[0].sourceIp, "10.0.0.5");
});

Deno.test("emitServeConfigReloaded: a signal is the system, with no client", () => {
  const { events, emitter } = recorder();
  emitServeConfigReloaded(
    { auditEmitter: emitter },
    { trigger: "signal" },
    report,
  );
  assertEquals(events[0].principalId, "system");
  assertEquals(events[0].client, undefined);
});

Deno.test("emitServeConfigReloaded: an emitter that throws never breaks the reload", () => {
  const emitter = {
    emit: () => {
      throw new Error("sink down");
    },
  } as unknown as AuditEmitter;
  emitServeConfigReloaded(
    { auditEmitter: emitter },
    { trigger: "poll" },
    report,
  );
});

Deno.test("serveConfigReloadedDetail: names settings that land only after their follow-up", () => {
  assertEquals(
    serveConfigReloadedDetail("reload", {
      applied: ["auth.admins"],
      landing: ["auth.admins"],
      needsRestart: [],
      overridden: [],
    }),
    "trigger=reload applied=auth.admins landing=auth.admins",
  );
});

Deno.test("emitServeConfigNotLanded: records the settings that did not land as a failure", () => {
  const { events, emitter } = recorder();
  emitServeConfigNotLanded(
    { auditEmitter: emitter, instanceId: "inst-1" },
    { trigger: "reload", principal: { kind: "user", id: "alice" } },
    ["auth.admins"],
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].action, SERVE_CONFIG_RELOADED_ACTION);
  assertEquals(events[0].outcome, "failure");
  assertEquals(events[0].detail, "trigger=reload not-landed=auth.admins");
});
