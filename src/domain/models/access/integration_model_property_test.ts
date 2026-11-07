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
import fc from "fast-check";
import type { MethodContext } from "../model.ts";
import {
  type Integration,
  integrationDefinitionName,
  integrationModel,
} from "./integration_model.ts";

const HASH = `sha256:${"a".repeat(64)}`;

const arbCeiling = fc.array(
  fc.record({
    actions: fc.array(
      fc.constantFrom("run", "read", "approve", "signal", "write"),
      { minLength: 1 },
    ),
    resource: fc.constantFrom("workflow:*", "workflow:a", "model:*"),
  }),
  { maxLength: 3 },
).map((ceiling) => ({ version: 1, ceiling }));

const arbCommand = fc.oneof(
  fc.record({ kind: fc.constant("register" as const), ceiling: arbCeiling }),
  fc.record({ kind: fc.constant("setCeiling" as const), ceiling: arbCeiling }),
  fc.record({ kind: fc.constant("revoke" as const) }),
);

Deno.test("integration: its id and hash never change, revoked stays revoked, and a stored ceiling is always valid", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbCommand, { maxLength: 12 }),
      async (commands) => {
        let stored: Integration | null = null;
        const context = {
          definition: { name: integrationDefinitionName("app") },
          readResource: () => Promise.resolve(stored),
          writeResource: (_spec: string, _name: string, value: unknown) => {
            stored = value as Integration;
            return Promise.resolve({ name: "integration-main" });
          },
        } as unknown as MethodContext;
        let wasRevoked = false;
        for (const command of commands) {
          const args = command.kind === "register"
            ? {
              id: "app",
              name: "App",
              ceiling: command.ceiling,
              credentialHash: HASH,
            }
            : command.kind === "setCeiling"
            ? { ceiling: command.ceiling }
            : {};
          await integrationModel.methods[command.kind]
            .execute(args as never, context)
            .catch(() => {});
          const current = stored as Integration | null;
          if (current === null) continue;
          assertEquals(current.id, "app");
          assertEquals(current.credentialHash, HASH);
          const entries = (current.ceiling as {
            ceiling: { actions: string[]; resource: string }[];
          }).ceiling;
          for (const entry of entries) {
            assertEquals(entry.resource.startsWith("workflow:"), true);
            assert(!entry.actions.includes("write"));
          }
          if (wasRevoked) assertEquals(current.state, "revoked");
          wasRevoked = current.state === "revoked";
        }
      },
    ),
  );
});
