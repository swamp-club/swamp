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
  classifyApiCallService,
  collectiveOf,
  evaluateCollectiveMembership,
  evaluateVersionExists,
  registryCheckNotRun,
  registryChecksVerdict,
} from "./extension_publish_checks.ts";

Deno.test("collectiveOf: returns the namespace between @ and /", () => {
  assertEquals(collectiveOf("@acme/tool"), "acme");
  assertEquals(collectiveOf("@swamp/ssh"), "swamp");
});

Deno.test("evaluateCollectiveMembership: member of a plain collective passes both checks", () => {
  const result = evaluateCollectiveMembership({
    extensionName: "@acme/tool",
    collectives: ["acme", "other"],
    username: "someone",
  });
  assertEquals(result.reserved.status, "passed");
  assertEquals(result.reserved.message, 'Collective "@acme" is not reserved.');
  assertEquals(result.membership.status, "passed");
});

Deno.test("evaluateCollectiveMembership: non-member fails with the push's exact message", () => {
  const result = evaluateCollectiveMembership({
    extensionName: "@acme/tool",
    collectives: ["mine", "ours"],
    username: "someone",
  });
  assertEquals(result.membership.status, "failed");
  assertEquals(
    result.membership.message,
    'Extension collective "@acme" is not one of your collectives (@mine, @ours). ' +
      "Use one of: @mine, @ours",
  );
});

Deno.test("evaluateCollectiveMembership: unknown collectives fall back to the username", () => {
  const ok = evaluateCollectiveMembership({
    extensionName: "@seth/tool",
    collectives: undefined,
    username: "seth",
  });
  assertEquals(ok.membership.status, "passed");

  const notOk = evaluateCollectiveMembership({
    extensionName: "@acme/tool",
    collectives: undefined,
    username: "seth",
  });
  assertEquals(notOk.membership.status, "failed");
  assertEquals(
    notOk.membership.message,
    'Extension collective "@acme" is not one of your collectives (@seth). ' +
      "Use one of: @seth",
  );
});

Deno.test("evaluateCollectiveMembership: reserved collective needs the registry's membership list", () => {
  const unverified = evaluateCollectiveMembership({
    extensionName: "@swamp/ssh",
    collectives: undefined,
    username: "swamp",
  });
  assertEquals(unverified.reserved.status, "failed");
  assertEquals(
    unverified.reserved.message,
    'Extension uses reserved collective "@swamp". ' +
      "Could not verify membership — please check your network connection and try again.",
  );
  assertEquals(unverified.membership.status, "not-run");
  assertEquals(unverified.membership.cause, "membership-unverified");

  const verified = evaluateCollectiveMembership({
    extensionName: "@swamp/ssh",
    collectives: ["swamp"],
    username: "seth",
  });
  assertEquals(verified.reserved.status, "passed");
  assertEquals(verified.membership.status, "passed");

  const outsider = evaluateCollectiveMembership({
    extensionName: "@swamp/ssh",
    collectives: ["acme"],
    username: "seth",
  });
  assertEquals(outsider.reserved.status, "passed");
  assertEquals(outsider.membership.status, "failed");
});

Deno.test("evaluateVersionExists: a match on any channel fails with the push's exact message", () => {
  const result = evaluateVersionExists({
    extensionName: "@acme/tool",
    version: "2026.10.06.1",
    published: { version: "2026.10.06.1", channel: "beta" },
  });
  assertEquals(result.status, "failed");
  assertEquals(
    result.message,
    "Version 2026.10.06.1 already exists for @acme/tool.",
  );
});

Deno.test("evaluateVersionExists: no published match passes", () => {
  const result = evaluateVersionExists({
    extensionName: "@acme/tool",
    version: "2026.10.06.1",
    published: null,
  });
  assertEquals(result.status, "passed");
  assertEquals(
    result.message,
    "Version 2026.10.06.1 is not published for @acme/tool.",
  );
});

Deno.test("registryCheckNotRun: carries the cause and the reason", () => {
  assertEquals(
    registryCheckNotRun("version-exists", "no-credentials", "no credentials"),
    {
      name: "version-exists",
      status: "not-run",
      message: "no credentials",
      cause: "no-credentials",
    },
  );
});

Deno.test("registryChecksVerdict: a failed check ends the run with its own message", () => {
  assertEquals(
    registryChecksVerdict([
      { name: "authentication", status: "passed", message: "ok" },
      registryCheckNotRun("version-exists", "registry-unavailable", "down"),
      {
        name: "collective-membership",
        status: "failed",
        message: "not yours",
      },
    ]),
    { ok: false, message: "not yours" },
  );
});

Deno.test("registryChecksVerdict: a check the registry did not answer ends the run; one never asked does not", () => {
  assertEquals(
    registryChecksVerdict([
      registryCheckNotRun(
        "version-exists",
        "registry-unavailable",
        "registry lookup failed: down",
      ),
    ]),
    {
      ok: false,
      message:
        'Registry check "version exists" could not run: registry lookup failed: down',
    },
  );
  assertEquals(
    registryChecksVerdict([
      registryCheckNotRun("authentication", "no-credentials", "no credentials"),
      registryCheckNotRun("version-exists", "no-credentials", "no credentials"),
    ]),
    { ok: true },
  );
  assertEquals(registryChecksVerdict([]), { ok: true });
});

Deno.test("classifyApiCallService: groups by host", () => {
  const registry = "https://swamp-club.com";
  assertEquals(
    classifyApiCallService("https://swamp-club.com/api/whoami", registry),
    "registry",
  );
  assertEquals(
    classifyApiCallService("https://api.osv.dev/v1/query", registry),
    "osv",
  );
  assertEquals(
    classifyApiCallService("https://registry.npmjs.org/zod", registry),
    "npm",
  );
  assertEquals(
    classifyApiCallService(
      "https://api.npmjs.org/downloads/point/last-week/zod",
      registry,
    ),
    "npm",
  );
  assertEquals(
    classifyApiCallService("https://example.com/x", registry),
    "other",
  );
  assertEquals(classifyApiCallService("not a url", registry), "other");
});
