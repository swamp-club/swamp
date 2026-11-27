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
import { parseAuditConfig, type ServeConfigFile } from "./serve_config.ts";
import {
  alertRulesFrom,
  auditPolicyFrom,
  diffAuditConfig,
  runningAuditConfig,
} from "./serve_audit_reload.ts";

function audit(block: Record<string, unknown>) {
  return parseAuditConfig({ audit: block } as unknown as ServeConfigFile);
}

const BASE = {
  stores: [{ target: "datastore" }],
  "fail-open": true,
  policy: { "default-level": "metadata" },
};

Deno.test("diffAuditConfig: policy, alerts, fail-open and sinks apply on reload", () => {
  const changes = diffAuditConfig(
    audit(BASE),
    audit({
      ...BASE,
      "fail-open": false,
      policy: { "default-level": "request" },
      alerts: [{
        name: "denials",
        match: { outcome: "denied" },
        threshold: { count: 5, "window-seconds": 60 },
        action: { type: "log" },
      }],
    }),
  );
  assertEquals(changes.applied, [
    "audit.policy",
    "audit.alerts",
    "audit.fail-open",
  ]);
  assertEquals(changes.needsRestart, []);
});

Deno.test("diffAuditConfig: stores, WAL and HMAC need a restart", () => {
  const changes = diffAuditConfig(
    audit(BASE),
    audit({
      ...BASE,
      stores: [{ target: "datastore" }, { target: "local" }],
      wal: { "max-size": "10MB" },
      hmac: { enabled: true, vault: "v", key: "k" },
    }),
  );
  assertEquals(changes.applied, []);
  assertEquals(changes.needsRestart.map((entry) => entry.setting), [
    "audit.stores",
    "audit.wal",
    "audit.hmac",
  ]);
});

Deno.test("diffAuditConfig: turning audit on or off needs a restart; no audit is no change", () => {
  assertEquals(
    diffAuditConfig(null, audit(BASE)).needsRestart[0].setting,
    "audit",
  );
  assertEquals(
    diffAuditConfig(audit(BASE), null).needsRestart[0].setting,
    "audit",
  );
  assertEquals(diffAuditConfig(null, null), { applied: [], needsRestart: [] });
  assertEquals(diffAuditConfig(audit(BASE), audit(BASE)), {
    applied: [],
    needsRestart: [],
  });
});

Deno.test("auditPolicyFrom and alertRulesFrom: build what the audit block describes", () => {
  const config = audit({
    ...BASE,
    policy: {
      "default-level": "metadata",
      rules: [{ category: "auth", level: "none" }],
    },
    alerts: [{
      name: "denials",
      match: { outcome: "denied" },
      threshold: { count: 5, "window-seconds": 60 },
      action: { type: "log" },
    }],
  })!;
  assertEquals(auditPolicyFrom(config).evaluate("auth", "auth.login"), "none");
  assertEquals(
    auditPolicyFrom(config).evaluate("admin", "access.reload"),
    "metadata",
  );
  assertEquals(alertRulesFrom(config).map((rule) => rule.name), ["denials"]);
  assertEquals(alertRulesFrom(config)[0].threshold.windowSeconds, 60);
});

function reloadTwice(
  start: ReturnType<typeof audit> | null,
  next: ReturnType<typeof audit> | null,
) {
  const first = diffAuditConfig(start, next);
  const running = runningAuditConfig(start, next, first);
  return { first, second: diffAuditConfig(running, next) };
}

Deno.test("runningAuditConfig: a restart-only audit change is reported on every reload", () => {
  const { first, second } = reloadTwice(
    audit(BASE),
    audit({
      ...BASE,
      stores: [{ target: "datastore" }, { target: "local" }],
      hmac: { enabled: true, vault: "v", key: "k" },
    }),
  );
  assertEquals(first.needsRestart, second.needsRestart);
  assertEquals(second.needsRestart.map((entry) => entry.setting), [
    "audit.stores",
    "audit.hmac",
  ]);
});

Deno.test("runningAuditConfig: an applied audit change is reported once while a restart-only one beside it repeats", () => {
  const { first, second } = reloadTwice(
    audit(BASE),
    audit({
      ...BASE,
      "fail-open": false,
      policy: { "default-level": "request" },
      wal: { "max-size": "10MB" },
    }),
  );
  assertEquals(first.applied, ["audit.policy", "audit.fail-open"]);
  assertEquals(second.applied, []);
  assertEquals(second.needsRestart.map((entry) => entry.setting), [
    "audit.wal",
  ]);
});

Deno.test("runningAuditConfig: turning audit on or off is reported on every reload", () => {
  assertEquals(
    reloadTwice(null, audit(BASE)).second.needsRestart.map((e) => e.setting),
    ["audit"],
  );
  assertEquals(
    reloadTwice(audit(BASE), null).second.needsRestart.map((e) => e.setting),
    ["audit"],
  );
});

Deno.test("runningAuditConfig: reverting the file clears what was waiting for a restart", () => {
  const start = audit(BASE);
  const changed = audit({ ...BASE, wal: { "max-size": "10MB" } });
  const running = runningAuditConfig(
    start,
    changed,
    diffAuditConfig(start, changed),
  );
  assertEquals(diffAuditConfig(running, start), {
    applied: [],
    needsRestart: [],
  });
});
