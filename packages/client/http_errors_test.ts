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
import { scrubSecrets, SwampHttpError } from "./http_errors.ts";

const ID = "0f4b7c4e-8d55-4c1a-9f1e-3a2b1c0d9e8f";
const HEX = "a".repeat(64);

Deno.test("scrubSecrets: removes delegated tokens and integration credentials", () => {
  const text =
    `access swda1.${ID}.${HEX} refresh swdr1.${ID}.${HEX} redeem swdx1.${ID}.${HEX} credential swi1.slack-bot.Zx9_-k`;
  const scrubbed = scrubSecrets(text);
  assertEquals(
    scrubbed,
    "access [redacted] refresh [redacted] redeem [redacted] credential [redacted]",
  );
});

Deno.test("SwampHttpError: scrubs its message and serialises only its own fields", () => {
  const error = new SwampHttpError({
    status: 401,
    code: "invalid_grant",
    message: `refused swdr1.${ID}.${HEX}`,
    route: "delegations/refresh",
    reason: "mismatch",
  });
  assertEquals(error.message, "refused [redacted]");
  assertEquals(error.cause, undefined);
  assertEquals(JSON.parse(JSON.stringify(error)), {
    name: "SwampHttpError",
    message: "refused [redacted]",
    status: 401,
    code: "invalid_grant",
    route: "delegations/refresh",
    reason: "mismatch",
  });
  assert(!String(error.stack).includes(HEX));
  assert(!error.linkEnded);
});
