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
import { mergeIdentityHeaders } from "./client_identity.ts";

Deno.test("mergeIdentityHeaders: sets User-Agent from identity.userAgent", () => {
  const headers = mergeIdentityHeaders(
    { userAgent: "swamp-cli/1.2.3" },
    undefined,
  );
  assertEquals(headers.get("User-Agent"), "swamp-cli/1.2.3");
});

Deno.test("mergeIdentityHeaders: omits User-Agent when not in identity", () => {
  const headers = mergeIdentityHeaders({ bearerToken: "tok" }, undefined);
  assertEquals(headers.get("User-Agent"), null);
});

Deno.test("mergeIdentityHeaders: sets all identity headers together", () => {
  const headers = mergeIdentityHeaders(
    {
      bearerToken: "tok",
      distinctId: "device-uuid",
      userAgent: "swamp-cli/1.2.3",
    },
    undefined,
  );
  assertEquals(headers.get("Authorization"), "Bearer tok");
  assertEquals(headers.get("Swamp-Distinct-Id"), "device-uuid");
  assertEquals(headers.get("User-Agent"), "swamp-cli/1.2.3");
});

Deno.test("mergeIdentityHeaders: caller headers override identity User-Agent", () => {
  const headers = mergeIdentityHeaders(
    { userAgent: "swamp-cli/1.2.3" },
    { "User-Agent": "custom/agent" },
  );
  assertEquals(headers.get("User-Agent"), "custom/agent");
});
