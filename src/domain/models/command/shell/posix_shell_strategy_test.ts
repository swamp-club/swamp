// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { PosixShellStrategy } from "./posix_shell_strategy.ts";
import { VaultSecretBag } from "../../../vaults/vault_secret_bag.ts";

Deno.test("PosixShellStrategy.buildInvocation: wraps command in sh -c", () => {
  const strategy = new PosixShellStrategy();
  assertEquals(
    strategy.buildInvocation("echo hello"),
    { command: "sh", args: ["-c", "echo hello"] },
  );
});

Deno.test("PosixShellStrategy.buildInvocation: passes command through verbatim (no escaping)", () => {
  // The shell handles parsing — strategy doesn't pre-escape. This
  // matches `Deno.Command` semantics where args are passed as-is.
  const strategy = new PosixShellStrategy();
  const cmd = `echo "hello $WORLD" && exit 0`;
  assertEquals(
    strategy.buildInvocation(cmd),
    { command: "sh", args: ["-c", cmd] },
  );
});

Deno.test("PosixShellStrategy.resolveSecrets: delegates to VaultSecretBag.resolveForShell", () => {
  const strategy = new PosixShellStrategy();
  const bag = new VaultSecretBag();
  const sentinel = bag.addSecret("secret-value");

  const resolved = strategy.resolveSecrets(`echo ${sentinel}`, bag);

  // POSIX strategy emits ${__SWAMP_VAULT_N} references and quotes them
  // when not already inside double quotes.
  assertEquals(resolved.command, 'echo "${__SWAMP_VAULT_0}"');
  assertEquals(resolved.env, { __SWAMP_VAULT_0: "secret-value" });
});

Deno.test("PosixShellStrategy.resolveSecrets: empty bag returns command unchanged", () => {
  const strategy = new PosixShellStrategy();
  const bag = new VaultSecretBag();
  const resolved = strategy.resolveSecrets("echo hello", bag);
  assertEquals(resolved.command, "echo hello");
  assertEquals(resolved.env, {});
});
