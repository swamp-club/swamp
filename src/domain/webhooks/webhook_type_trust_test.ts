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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  evaluateWebhookTypeTrust,
  untrustedWebhookSchemeMessage,
} from "./webhook_type_trust.ts";

Deno.test("evaluateWebhookTypeTrust: a local type is trusted with an empty list", () => {
  assertEquals(
    evaluateWebhookTypeTrust("@acme/hook", { kind: "local" }, []),
    { trusted: true },
  );
});

Deno.test("evaluateWebhookTypeTrust: a pulled type needs its scheme collective trusted", () => {
  const origin = { kind: "pulled", extensionName: "@acme/hooks" } as const;
  assertEquals(evaluateWebhookTypeTrust("@acme/hook", origin, ["swamp"]), {
    trusted: false,
    collective: "acme",
  });
  assertEquals(
    evaluateWebhookTypeTrust("@acme/hook", origin, ["swamp", "acme"]),
    { trusted: true },
  );
});

Deno.test("evaluateWebhookTypeTrust: a pulled type needs its owning extension collective trusted", () => {
  assertEquals(
    evaluateWebhookTypeTrust(
      "@swamp/hook",
      { kind: "pulled", extensionName: "@evil/hooks" },
      ["swamp"],
    ),
    { trusted: false, collective: "evil" },
  );
});

Deno.test("evaluateWebhookTypeTrust: unknown origin is judged as pulled", () => {
  assertEquals(evaluateWebhookTypeTrust("@acme/hook", undefined, []), {
    trusted: false,
    collective: "acme",
  });
  assertEquals(evaluateWebhookTypeTrust("@acme/hook", undefined, ["acme"]), {
    trusted: true,
  });
});

Deno.test("evaluateWebhookTypeTrust: compares collectives case-insensitively", () => {
  assertEquals(
    evaluateWebhookTypeTrust("@Acme/hook", { kind: "pulled" }, ["ACME"]),
    { trusted: true },
  );
});

Deno.test("untrustedWebhookSchemeMessage: names the route, scheme, collective and the fix", () => {
  const message = untrustedWebhookSchemeMessage(
    "/hooks/a",
    "@acme/hook",
    "acme",
  );
  assertStringIncludes(message, "/hooks/a");
  assertStringIncludes(message, "'@acme/hook'");
  assertStringIncludes(message, "collective 'acme'");
  assertStringIncludes(message, "swamp extension trust add acme");
  assertStringIncludes(message, "swamp serve reload");
});
