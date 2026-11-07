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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { IntegrationView } from "../../libswamp/access/integration_list.ts";
import {
  renderIntegration,
  renderIntegrationList,
  renderIntegrationRegistered,
  renderIntegrationRevoked,
} from "./access_integration_output.ts";

await initializeLogging({});

const VIEW: IntegrationView = {
  id: "app",
  name: "App",
  state: "active",
  ceiling: {
    version: 1,
    ceiling: [{ actions: ["read"], resource: "workflow:deploy" }],
  },
  ceilingDigest: "sha256:abc",
  createdAt: new Date(0).toISOString(),
};

function captured(fn: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

Deno.test("renderIntegrationRegistered: json has the credential, once", () => {
  const output = captured(() =>
    renderIntegrationRegistered(VIEW, "swi1.app.secret", "json")
  );
  assertEquals(JSON.parse(output).credential, "swi1.app.secret");
});

Deno.test("renderIntegrationRegistered: log mode prints the credential straight to stdout", () => {
  assertStringIncludes(
    captured(() => renderIntegrationRegistered(VIEW, "swi1.app.secret", "log")),
    "swi1.app.secret",
  );
});

Deno.test("renderIntegration and renderIntegrationList: never show a credential or hash", () => {
  for (
    const output of [
      captured(() => renderIntegration(VIEW, "json")),
      captured(() =>
        renderIntegrationList({ integrations: [VIEW], count: 1 }, "json")
      ),
    ]
  ) {
    assert(!output.includes("credential"), output);
  }
});

Deno.test("renderIntegrationRevoked: json says whether it was already revoked", () => {
  assertEquals(
    JSON.parse(captured(() => renderIntegrationRevoked(VIEW, true, "json")))
      .alreadyRevoked,
    true,
  );
  assertEquals(
    JSON.parse(captured(() => renderIntegrationRevoked(VIEW, false, "json")))
      .alreadyRevoked,
    false,
  );
});

Deno.test("renderIntegration: a ceiling this build can't read doesn't throw, in log mode", () => {
  renderIntegration({ ...VIEW, ceiling: { version: 9 } }, "log");
  renderIntegration({ ...VIEW, ceiling: { version: 9, ceiling: [] } }, "log");
  renderIntegration({
    ...VIEW,
    ceiling: { version: 2, ceiling: [{ resource: "x", rules: {} }] },
  }, "log");
  renderIntegrationRevoked(
    { ...VIEW, ceiling: { version: 2, ceiling: [{ resource: "x" }] } },
    false,
    "log",
  );
  renderIntegration({ ...VIEW, ceiling: { version: 1, ceiling: [] } }, "log");
  renderIntegrationList({ integrations: [], count: 0 }, "log");
  renderIntegrationList({ integrations: [VIEW], count: 1 }, "log");
});
