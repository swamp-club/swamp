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
import { tokenVaultRejectedMessage } from "./access_token_vault_guidance.ts";

Deno.test("tokenVaultRejectedMessage: gives a safe mint handoff command", () => {
  const message = tokenVaultRejectedMessage("mint", "alice-01", "tokens");

  assertStringIncludes(message, "Rerun without --vault.");
  assertStringIncludes(
    message,
    "swamp access token reveal 'alice-01' --repo-dir <repo> --yes --json",
  );
  assertStringIncludes(
    message,
    "swamp vault put 'tokens' 'server-token-alice-01' --yes",
  );
});

Deno.test("tokenVaultRejectedMessage: directs remote rotate handoff to the serve host", () => {
  const message = tokenVaultRejectedMessage("rotate", "alice-01", "tokens", {
    remote: true,
  });

  assertStringIncludes(message, "The requested rotation was not performed.");
  assertStringIncludes(message, "on the serve host");
});

Deno.test("tokenVaultRejectedMessage: describes a remote mint accurately", () => {
  const message = tokenVaultRejectedMessage("mint", "alice-01", "tokens", {
    remote: true,
  });

  assertStringIncludes(message, "The requested minting was not performed.");
});

Deno.test("tokenVaultRejectedMessage: describes local rejection without blaming a datastore", () => {
  const mint = tokenVaultRejectedMessage("mint", "alice", "team-vault");
  assertStringIncludes(mint, "--vault is not supported when minting locally");
  assertEquals(mint.includes("datastore"), false);

  const rotate = tokenVaultRejectedMessage("rotate", "alice", "team-vault");
  assertStringIncludes(
    rotate,
    "--vault is not supported when rotating locally",
  );
  assertEquals(rotate.includes("datastore"), false);
});

Deno.test("tokenVaultRejectedMessage: shell-quotes user-provided names", () => {
  const message = tokenVaultRejectedMessage("mint", "alice's", "team vault");

  assertStringIncludes(message, "'alice'\"'\"'s'");
  assertStringIncludes(message, "'team vault'");
});
