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
import {
  matchesSinkFilter,
  parseSinkFilter,
  validateSinkFilter,
} from "./sink_filter.ts";
import { createAuditEvent } from "./audit_event.ts";

function makeEvent(
  overrides?: Partial<Parameters<typeof createAuditEvent>[0]>,
) {
  return createAuditEvent({
    instanceId: "test",
    category: "auth",
    stage: "response",
    outcome: "success",
    action: "auth.login",
    resourceKind: "user",
    resourceName: "paul",
    principalKind: "user",
    principalId: "paul",
    initiatedBy: "paul",
    sourceIp: "127.0.0.1",
    requestId: "req-1",
    ...overrides,
  });
}

Deno.test("matchesSinkFilter: empty filter matches all events", () => {
  const event = makeEvent();
  assertEquals(matchesSinkFilter(event, {}), true);
});

Deno.test("matchesSinkFilter: categories filter matches included category", () => {
  const event = makeEvent({ category: "secrets" });
  assertEquals(
    matchesSinkFilter(event, { categories: ["secrets", "auth"] }),
    true,
  );
});

Deno.test("matchesSinkFilter: categories filter rejects excluded category", () => {
  const event = makeEvent({ category: "execution" });
  assertEquals(
    matchesSinkFilter(event, { categories: ["secrets", "auth"] }),
    false,
  );
});

Deno.test("matchesSinkFilter: tier management matches system events", () => {
  const event = makeEvent({ category: "system", action: "instance.start" });
  assertEquals(matchesSinkFilter(event, { tier: "management" }), true);
});

Deno.test("matchesSinkFilter: tier management rejects data events", () => {
  const event = makeEvent({ category: "execution", action: "model.run" });
  assertEquals(matchesSinkFilter(event, { tier: "management" }), false);
});

Deno.test("matchesSinkFilter: tier all matches everything", () => {
  const event = makeEvent({ category: "execution", action: "model.run" });
  assertEquals(matchesSinkFilter(event, { tier: "all" }), true);
});

Deno.test("matchesSinkFilter: outcomes filter matches", () => {
  const event = makeEvent({ outcome: "denied" });
  assertEquals(
    matchesSinkFilter(event, { outcomes: ["denied", "failure"] }),
    true,
  );
});

Deno.test("matchesSinkFilter: outcomes filter rejects", () => {
  const event = makeEvent({ outcome: "success" });
  assertEquals(
    matchesSinkFilter(event, { outcomes: ["denied", "failure"] }),
    false,
  );
});

Deno.test("matchesSinkFilter: combined filters all must match", () => {
  const event = makeEvent({
    category: "secrets",
    outcome: "success",
    action: "vault.read-secret",
  });
  assertEquals(
    matchesSinkFilter(event, {
      categories: ["secrets"],
      outcomes: ["success"],
      tier: "data",
    }),
    true,
  );
});

Deno.test("parseSinkFilter: defaults to management tier", () => {
  const filter = parseSinkFilter({});
  assertEquals(filter.tier, "management");
});

Deno.test("parseSinkFilter: parses filter from raw config", () => {
  const filter = parseSinkFilter({
    filter: {
      categories: ["auth", "secrets"],
      tier: "all",
      outcomes: ["denied"],
    },
  });
  assertEquals(filter.categories, ["auth", "secrets"]);
  assertEquals(filter.tier, "all");
  assertEquals(filter.outcomes, ["denied"]);
});

Deno.test("validateSinkFilter: no problems for an absent or valid filter", () => {
  assertEquals(validateSinkFilter({}), []);
  assertEquals(validateSinkFilter({ filter: null }), []);
  assertEquals(
    validateSinkFilter({
      filter: {
        categories: [
          "auth",
          "access",
          "execution",
          "secrets",
          "admin",
          "data",
          "system",
        ],
        tier: "data",
        outcomes: ["success", "failure", "denied"],
      },
    }),
    [],
  );
  assertEquals(validateSinkFilter({ filter: { tier: "all" } }), []);
  // An empty YAML value reads as null, which parseSinkFilter treats as unset.
  assertEquals(
    validateSinkFilter({
      filter: { tier: null, categories: null, outcomes: null },
    }),
    [],
  );
});

Deno.test("validateSinkFilter: a filter that is not a mapping is one problem", () => {
  assertEquals(validateSinkFilter({ filter: "management" }), [
    'filter must be a mapping, got "management"',
  ]);
  assertEquals(validateSinkFilter({ filter: ["auth"] }).length, 1);
});

Deno.test("validateSinkFilter: reports unknown keys, a bad tier and bad list values", () => {
  assertEquals(
    validateSinkFilter({
      filter: {
        tiers: "data",
        categories: ["auth", "authz", 3],
        tier: "managment",
        outcomes: "denied",
      },
    }),
    [
      "filter has unknown key tiers (expected categories, tier, outcomes)",
      'filter.categories has unknown value "authz" (expected one of auth, access, execution, secrets, admin, data, system)',
      "filter.categories has unknown value 3 (expected one of auth, access, execution, secrets, admin, data, system)",
      'filter.tier has unknown value "managment" (expected one of management, data, all)',
      'filter.outcomes must be a list, got "denied"',
    ],
  );
});

Deno.test("validateSinkFilter: parseSinkFilter still reads a bad filter as written", () => {
  const raw = { filter: { tier: "managment" } };
  assertEquals(validateSinkFilter(raw).length, 1);
  assertEquals(String(parseSinkFilter(raw).tier), "managment");
});
