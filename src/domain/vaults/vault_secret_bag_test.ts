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
import { getQuoteContext } from "./vault_secret_bag.ts";
import { VaultSecretBag } from "./vault_secret_bag.ts";

Deno.test("getQuoteContext", async (t) => {
  await t.step("returns 'unquoted' for position outside any quotes", () => {
    assertEquals(getQuoteContext("echo hello", 5), "unquoted");
  });

  await t.step("returns 'double' for position inside double quotes", () => {
    assertEquals(getQuoteContext('echo "hello', 7), "double");
  });

  await t.step("returns 'single' for position inside single quotes", () => {
    assertEquals(getQuoteContext("echo 'hello", 7), "single");
  });

  await t.step("returns 'unquoted' after closed double quotes", () => {
    assertEquals(getQuoteContext('echo "hello" world', 14), "unquoted");
  });

  await t.step("returns 'unquoted' after closed single quotes", () => {
    assertEquals(getQuoteContext("echo 'hello' world", 14), "unquoted");
  });

  await t.step("ignores escaped double quote outside single quotes", () => {
    assertEquals(getQuoteContext('echo \\"hello', 8), "unquoted");
  });

  await t.step(
    "does not treat backslash as escape inside single quotes",
    () => {
      assertEquals(getQuoteContext("echo '\\\"'rest", 10), "unquoted");
    },
  );

  await t.step("handles mixed quoting contexts", () => {
    const cmd = `echo "double" 'single' unquoted`;
    assertEquals(getQuoteContext(cmd, 6), "double");
    assertEquals(getQuoteContext(cmd, 16), "single");
    assertEquals(getQuoteContext(cmd, 24), "unquoted");
  });

  await t.step("returns 'single' for position at start of content", () => {
    assertEquals(getQuoteContext("'hello", 1), "single");
  });

  await t.step("returns 'unquoted' at position 0", () => {
    assertEquals(getQuoteContext("'hello", 0), "unquoted");
  });
});

Deno.test("VaultSecretBag", async (t) => {
  await t.step("addSecret: returns unique sentinel tokens", () => {
    const bag = new VaultSecretBag();
    const s1 = bag.addSecret("secret1");
    const s2 = bag.addSecret("secret2");
    assertEquals(s1 !== s2, true);
    assertEquals(s1.startsWith("__SWAMP_VSEC_"), true);
    assertEquals(s1.endsWith("__"), true);
    assertEquals(s2.startsWith("__SWAMP_VSEC_"), true);
  });

  await t.step("addSecret: sentinel matches pattern", () => {
    const bag = new VaultSecretBag();
    const sentinel = bag.addSecret("test");
    const matches = sentinel.match(VaultSecretBag.SENTINEL_PATTERN);
    assertEquals(matches !== null, true);
    assertEquals(matches![0], sentinel);
  });

  await t.step("isEmpty: true when no secrets added", () => {
    const bag = new VaultSecretBag();
    assertEquals(bag.isEmpty, true);
  });

  await t.step("isEmpty: false after adding a secret", () => {
    const bag = new VaultSecretBag();
    bag.addSecret("test");
    assertEquals(bag.isEmpty, false);
  });

  await t.step("resolveRaw: replaces sentinel with raw value", () => {
    const bag = new VaultSecretBag();
    const sentinel = bag.addSecret("my-secret-value");
    assertEquals(
      bag.resolveRaw(`prefix ${sentinel} suffix`),
      "prefix my-secret-value suffix",
    );
  });

  await t.step("resolveRaw: replaces multiple sentinels", () => {
    const bag = new VaultSecretBag();
    const s1 = bag.addSecret("val1");
    const s2 = bag.addSecret("val2");
    assertEquals(bag.resolveRaw(`${s1}-${s2}`), "val1-val2");
  });

  await t.step("resolveRaw: preserves strings without sentinels", () => {
    const bag = new VaultSecretBag();
    bag.addSecret("unused");
    assertEquals(bag.resolveRaw("no sentinels here"), "no sentinels here");
  });

  await t.step("resolveRaw: handles secrets with shell metacharacters", () => {
    const bag = new VaultSecretBag();
    const sentinel = bag.addSecret("pass;rm -rf /");
    assertEquals(bag.resolveRaw(sentinel), "pass;rm -rf /");
  });

  await t.step("resolveDeep: resolves strings in nested objects", () => {
    const bag = new VaultSecretBag();
    const s1 = bag.addSecret("secret-value");
    const s2 = bag.addSecret("other-value");
    const data = {
      simple: s1,
      nested: { deep: s2 },
      array: [s1, "plain"],
      number: 42,
      bool: true,
      nullVal: null,
    };
    const resolved = bag.resolveDeep(data);
    assertEquals(resolved, {
      simple: "secret-value",
      nested: { deep: "other-value" },
      array: ["secret-value", "plain"],
      number: 42,
      bool: true,
      nullVal: null,
    });
  });

  await t.step(
    "resolveForShell: replaces sentinel with env var reference",
    () => {
      const bag = new VaultSecretBag();
      const sentinel = bag.addSecret("my-password");
      const result = bag.resolveForShell(`echo ${sentinel}`);
      assertEquals(result.command, 'echo "${__SWAMP_VAULT_0}"');
      assertEquals(result.env, { __SWAMP_VAULT_0: "my-password" });
    },
  );

  await t.step("resolveForShell: handles multiple secrets", () => {
    const bag = new VaultSecretBag();
    const s1 = bag.addSecret("user");
    const s2 = bag.addSecret("pass");
    const cmd = "echo " + s1 + ":" + s2;
    const result = bag.resolveForShell(cmd);
    assertEquals(
      result.command,
      'echo "${__SWAMP_VAULT_0}":"${__SWAMP_VAULT_1}"',
    );
    assertEquals(result.env, {
      __SWAMP_VAULT_0: "user",
      __SWAMP_VAULT_1: "pass",
    });
  });

  await t.step(
    "resolveForShell: secret with shell metacharacters goes to env",
    () => {
      const bag = new VaultSecretBag();
      const sentinel = bag.addSecret("pass;rm -rf /|cat /etc/passwd&whoami");
      const result = bag.resolveForShell(`echo ${sentinel}`);
      assertEquals(result.command, 'echo "${__SWAMP_VAULT_0}"');
      assertEquals(
        result.env.__SWAMP_VAULT_0,
        "pass;rm -rf /|cat /etc/passwd&whoami",
      );
    },
  );

  await t.step("resolveForShell: skips secrets not in command", () => {
    const bag = new VaultSecretBag();
    bag.addSecret("unused-secret");
    const s2 = bag.addSecret("used-secret");
    const result = bag.resolveForShell(`echo ${s2}`);
    assertEquals(result.command, 'echo "${__SWAMP_VAULT_0}"');
    assertEquals(Object.keys(result.env).length, 1);
  });

  await t.step("resolveForShell: no secrets returns original command", () => {
    const bag = new VaultSecretBag();
    const result = bag.resolveForShell("echo hello world");
    assertEquals(result.command, "echo hello world");
    assertEquals(result.env, {});
  });

  await t.step(
    "resolveForShell: inside double quotes uses bare env var ref",
    () => {
      const bag = new VaultSecretBag();
      const sentinel = bag.addSecret("my-token");
      const cmd = 'curl -H "Authorization: Bearer ' + sentinel +
        '" https://api.example.com';
      const result = bag.resolveForShell(cmd);
      assertEquals(
        result.command,
        'curl -H "Authorization: Bearer ${__SWAMP_VAULT_0}" https://api.example.com',
      );
      assertEquals(result.env, { __SWAMP_VAULT_0: "my-token" });
    },
  );

  await t.step(
    "resolveForShell: after closed double quotes uses quoted env var ref",
    () => {
      const bag = new VaultSecretBag();
      const sentinel = bag.addSecret("value");
      const cmd = 'echo "hello" ' + sentinel;
      const result = bag.resolveForShell(cmd);
      assertEquals(
        result.command,
        'echo "hello" "${__SWAMP_VAULT_0}"',
      );
    },
  );

  await t.step(
    "resolveForShell: respects escaped quotes",
    () => {
      const bag = new VaultSecretBag();
      const sentinel = bag.addSecret("val");
      // \" does not open a quoted section
      const cmd = 'echo \\"' + sentinel;
      const result = bag.resolveForShell(cmd);
      assertEquals(
        result.command,
        'echo \\"' + '"${__SWAMP_VAULT_0}"',
      );
    },
  );

  await t.step(
    "resolveForPowerShell: replaces sentinel with $env: reference",
    () => {
      const bag = new VaultSecretBag();
      const sentinel = bag.addSecret("my-password");
      const result = bag.resolveForPowerShell(`Write-Output ${sentinel}`);
      assertEquals(result.command, 'Write-Output "$env:__SWAMP_VAULT_0"');
      assertEquals(result.env, { __SWAMP_VAULT_0: "my-password" });
    },
  );

  await t.step("resolveForPowerShell: handles multiple secrets", () => {
    const bag = new VaultSecretBag();
    const s1 = bag.addSecret("user");
    const s2 = bag.addSecret("pass");
    const cmd = `Connect-Service -User ${s1} -Pass ${s2}`;
    const result = bag.resolveForPowerShell(cmd);
    assertEquals(
      result.command,
      'Connect-Service -User "$env:__SWAMP_VAULT_0" -Pass "$env:__SWAMP_VAULT_1"',
    );
    assertEquals(result.env, {
      __SWAMP_VAULT_0: "user",
      __SWAMP_VAULT_1: "pass",
    });
  });

  await t.step(
    "resolveForPowerShell: inside double quotes uses bare $env: reference",
    () => {
      // PowerShell interpolates `$env:VAR` inside double quotes natively;
      // adding extra quotes would yield broken syntax.
      const bag = new VaultSecretBag();
      const sentinel = bag.addSecret("token");
      const cmd = `Write-Output "auth: ${sentinel}"`;
      const result = bag.resolveForPowerShell(cmd);
      assertEquals(
        result.command,
        'Write-Output "auth: $env:__SWAMP_VAULT_0"',
      );
    },
  );

  await t.step(
    "resolveForPowerShell: skips secrets not in command",
    () => {
      const bag = new VaultSecretBag();
      bag.addSecret("unused");
      const sentinel = bag.addSecret("present");
      const cmd = `Write-Output ${sentinel}`;
      const result = bag.resolveForPowerShell(cmd);
      // The unused secret never gets a __SWAMP_VAULT_N slot.
      assertEquals(result.command, 'Write-Output "$env:__SWAMP_VAULT_0"');
      assertEquals(result.env, { __SWAMP_VAULT_0: "present" });
    },
  );

  await t.step(
    "resolveForPowerShell: no secrets returns original command",
    () => {
      const bag = new VaultSecretBag();
      const result = bag.resolveForPowerShell("Write-Output hello");
      assertEquals(result.command, "Write-Output hello");
      assertEquals(result.env, {});
    },
  );

  await t.step(
    "findSingleQuotedSentinels: detects sentinel inside single quotes",
    () => {
      const bag = new VaultSecretBag();
      const sentinel = bag.addSecret("secret");
      const cmd = `S='${sentinel}'`;
      const found = bag.findSingleQuotedSentinels(cmd);
      assertEquals(found, [sentinel]);
    },
  );

  await t.step(
    "findSingleQuotedSentinels: does not flag sentinel in double quotes",
    () => {
      const bag = new VaultSecretBag();
      const sentinel = bag.addSecret("secret");
      const cmd = `D="${sentinel}"`;
      const found = bag.findSingleQuotedSentinels(cmd);
      assertEquals(found, []);
    },
  );

  await t.step(
    "findSingleQuotedSentinels: does not flag unquoted sentinel",
    () => {
      const bag = new VaultSecretBag();
      const sentinel = bag.addSecret("secret");
      const cmd = `echo ${sentinel}`;
      const found = bag.findSingleQuotedSentinels(cmd);
      assertEquals(found, []);
    },
  );

  await t.step(
    "findSingleQuotedSentinels: detects only the single-quoted one among mixed",
    () => {
      const bag = new VaultSecretBag();
      const s1 = bag.addSecret("good");
      const s2 = bag.addSecret("bad");
      const cmd = `D="${s1}"\nS='${s2}'`;
      const found = bag.findSingleQuotedSentinels(cmd);
      assertEquals(found, [s2]);
    },
  );

  await t.step(
    "findSingleQuotedSentinels: returns empty when no secrets exist",
    () => {
      const bag = new VaultSecretBag();
      const found = bag.findSingleQuotedSentinels("echo 'hello'");
      assertEquals(found, []);
    },
  );

  await t.step(
    "findSingleQuotedSentinels: handles multi-line scripts",
    () => {
      const bag = new VaultSecretBag();
      const sentinel = bag.addSecret("secret");
      const cmd = `#!/bin/sh\necho "safe"\nBROKEN='${sentinel}'\necho done`;
      const found = bag.findSingleQuotedSentinels(cmd);
      assertEquals(found, [sentinel]);
    },
  );
});
