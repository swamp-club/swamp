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
import { PowerShellStrategy } from "./powershell_strategy.ts";
import { VaultSecretBag } from "../../../vaults/vault_secret_bag.ts";

Deno.test("PowerShellStrategy.buildInvocation: wraps command in powershell.exe -NoProfile -Command", () => {
  const strategy = new PowerShellStrategy();
  assertEquals(
    strategy.buildInvocation("Get-ChildItem"),
    {
      command: "powershell.exe",
      args: ["-NoProfile", "-Command", "Get-ChildItem"],
    },
  );
});

Deno.test("PowerShellStrategy.buildInvocation: passes command through verbatim (no escaping)", () => {
  // The shell handles parsing — strategy doesn't pre-escape.
  const strategy = new PowerShellStrategy();
  const cmd = `Write-Output "hello $env:USERNAME"; exit 0`;
  assertEquals(
    strategy.buildInvocation(cmd),
    {
      command: "powershell.exe",
      args: ["-NoProfile", "-Command", cmd],
    },
  );
});

Deno.test("PowerShellStrategy.resolveSecrets: rewrites sentinel to quoted $env:VAR outside quotes", () => {
  const strategy = new PowerShellStrategy();
  const bag = new VaultSecretBag();
  const sentinel = bag.addSecret("secret-value");

  const resolved = strategy.resolveSecrets(`Write-Output ${sentinel}`, bag);

  // Outside quotes: wrap in double quotes so PowerShell's argument
  // splitting on whitespace doesn't break the value when it's passed
  // to a native command.
  assertEquals(resolved.command, 'Write-Output "$env:__SWAMP_VAULT_0"');
  assertEquals(resolved.env, { __SWAMP_VAULT_0: "secret-value" });
});

Deno.test("PowerShellStrategy.resolveSecrets: rewrites sentinel to bare $env:VAR inside double quotes", () => {
  const strategy = new PowerShellStrategy();
  const bag = new VaultSecretBag();
  const sentinel = bag.addSecret("token-xyz");

  const resolved = strategy.resolveSecrets(
    `Write-Output "auth: ${sentinel}"`,
    bag,
  );

  // Inside double quotes: PowerShell already interpolates `$env:VAR`
  // so adding more quotes would be wrong.
  assertEquals(resolved.command, 'Write-Output "auth: $env:__SWAMP_VAULT_0"');
  assertEquals(resolved.env, { __SWAMP_VAULT_0: "token-xyz" });
});

Deno.test("PowerShellStrategy.resolveSecrets: handles multiple secrets", () => {
  const strategy = new PowerShellStrategy();
  const bag = new VaultSecretBag();
  const s1 = bag.addSecret("user");
  const s2 = bag.addSecret("pass");

  const resolved = strategy.resolveSecrets(
    `Connect-Service -User ${s1} -Password ${s2}`,
    bag,
  );

  assertEquals(
    resolved.command,
    'Connect-Service -User "$env:__SWAMP_VAULT_0" -Password "$env:__SWAMP_VAULT_1"',
  );
  assertEquals(resolved.env, {
    __SWAMP_VAULT_0: "user",
    __SWAMP_VAULT_1: "pass",
  });
});

Deno.test("PowerShellStrategy.resolveSecrets: empty bag returns command unchanged", () => {
  const strategy = new PowerShellStrategy();
  const bag = new VaultSecretBag();
  const resolved = strategy.resolveSecrets("Write-Output hello", bag);
  assertEquals(resolved.command, "Write-Output hello");
  assertEquals(resolved.env, {});
});
