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

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import {
  getQuoteContext,
  planPowerShellPlacement,
  planShellPlacement,
} from "./vault_secret_bag.ts";
import { isIssuedEntry, SecretBagRegistry } from "./secret_bag_registry.ts";
import { secretOccurrencesOf } from "./secret_occurrences.ts";
import { VaultSecretBag } from "./vault_secret_bag.ts";
import { sentinelIdentityOf } from "../expressions/provenance_map.ts";

/** The reference every secret of these tests stands for. */
const REF = { vaultName: "v", key: "k" };

/** Recorded sensitive values, each from {@link REF}. */
const entries = (...values: string[]) =>
  values.map((value) => ({ value, source: REF }));

/**
 * Issues a vault.get() reference from `bag` whose key is the value a load
 * reads for it (see {@link loaded}).
 */
const issue = (bag: VaultSecretBag, value: string) =>
  bag.addSecret({ vaultName: "v", key: value }, "test.location");

/**
 * `bag`'s delivery view, loaded as from a vault that holds each key as its
 * own value, so a test reads which value a sentinel delivers. Every vault
 * reference of the run is loaded, as a load of arguments carrying them all
 * would.
 */
function loaded(bag: VaultSecretBag): VaultSecretBag {
  const values = new Map<string, string>();
  for (const entry of bag.registry.all()) {
    if (isIssuedEntry(entry) && !entry.dataOrigin) {
      values.set(entry.sentinel, entry.reference.key);
    }
  }
  return bag.withLoaded(values);
}

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
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const s1 = issue(bag, "secret1");
    const s2 = issue(bag, "secret2");
    assertEquals(s1 !== s2, true);
    assertEquals(s1.startsWith("__SWAMP_VSEC_"), true);
    assertEquals(s1.endsWith("__"), true);
    assertEquals(s2.startsWith("__SWAMP_VSEC_"), true);
  });

  await t.step("addSecret: sentinel matches pattern", () => {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const sentinel = issue(bag, "test");
    const matches = sentinel.match(VaultSecretBag.SENTINEL_PATTERN);
    assertEquals(matches !== null, true);
    assertEquals(matches![0], sentinel);
  });

  await t.step("isEmpty: true when no secrets added", () => {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    assertEquals(bag.isEmpty, true);
  });

  await t.step("isEmpty: false after adding a secret", () => {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    issue(bag, "test");
    assertEquals(bag.isEmpty, false);
  });

  await t.step("resolveRaw: replaces sentinel with raw value", () => {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const sentinel = issue(bag, "my-secret-value");
    assertEquals(
      loaded(bag).resolveRaw(`prefix ${sentinel} suffix`),
      "prefix my-secret-value suffix",
    );
  });

  await t.step("resolveRaw: replaces multiple sentinels", () => {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const s1 = issue(bag, "val1");
    const s2 = issue(bag, "val2");
    assertEquals(loaded(bag).resolveRaw(`${s1}-${s2}`), "val1-val2");
  });

  await t.step("resolveRaw: preserves strings without sentinels", () => {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    issue(bag, "unused");
    assertEquals(
      loaded(bag).resolveRaw("no sentinels here"),
      "no sentinels here",
    );
  });

  await t.step("resolveRaw: handles secrets with shell metacharacters", () => {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const sentinel = issue(bag, "pass;rm -rf /");
    assertEquals(loaded(bag).resolveRaw(sentinel), "pass;rm -rf /");
  });

  await t.step("resolveDeep: resolves strings in nested objects", () => {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const s1 = issue(bag, "secret-value");
    const s2 = issue(bag, "other-value");
    const data = {
      simple: s1,
      nested: { deep: s2 },
      array: [s1, "plain"],
      number: 42,
      bool: true,
      nullVal: null,
    };
    const resolved = loaded(bag).resolveDeep(data);
    assertEquals(resolved, {
      simple: "secret-value",
      nested: { deep: "other-value" },
      array: ["secret-value", "plain"],
      number: 42,
      bool: true,
      nullVal: null,
    });
  });

  await t.step("resolveDeep: preserves __proto__ key", () => {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const sentinel = issue(bag, "proto-secret");
    const data = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(data, "__proto__", {
      value: sentinel,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(data, "normal", {
      value: "plain",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const resolved = loaded(bag).resolveDeep(data) as Record<string, unknown>;
    assertStrictEquals(Object.hasOwn(resolved, "__proto__"), true);
    assertEquals(resolved["__proto__"], "proto-secret");
    assertEquals(resolved["normal"], "plain");
  });

  await t.step(
    "resolveForShell: replaces sentinel with env var reference",
    () => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const sentinel = issue(bag, "my-password");
      const result = loaded(bag).resolveForShell(`echo ${sentinel}`);
      assertEquals(result.command, 'echo "${__SWAMP_VAULT_0}"');
      assertEquals(result.env, { __SWAMP_VAULT_0: "my-password" });
    },
  );

  await t.step("resolveForShell: handles multiple secrets", () => {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const s1 = issue(bag, "user");
    const s2 = issue(bag, "pass");
    const cmd = "echo " + s1 + ":" + s2;
    const result = loaded(bag).resolveForShell(cmd);
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
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const sentinel = issue(bag, "pass;rm -rf /|cat /etc/passwd&whoami");
      const result = loaded(bag).resolveForShell(`echo ${sentinel}`);
      assertEquals(result.command, 'echo "${__SWAMP_VAULT_0}"');
      assertEquals(
        result.env.__SWAMP_VAULT_0,
        "pass;rm -rf /|cat /etc/passwd&whoami",
      );
    },
  );

  await t.step("resolveForShell: skips secrets not in command", () => {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    issue(bag, "unused-secret");
    const s2 = issue(bag, "used-secret");
    const result = loaded(bag).resolveForShell(`echo ${s2}`);
    assertEquals(result.command, 'echo "${__SWAMP_VAULT_0}"');
    assertEquals(Object.keys(result.env).length, 1);
  });

  await t.step("resolveForShell: no secrets returns original command", () => {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const result = loaded(bag).resolveForShell("echo hello world");
    assertEquals(result.command, "echo hello world");
    assertEquals(result.env, {});
  });

  await t.step(
    "resolveForShell: inside double quotes uses bare env var ref",
    () => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const sentinel = issue(bag, "my-token");
      const cmd = 'curl -H "Authorization: Bearer ' + sentinel +
        '" https://api.example.com';
      const result = loaded(bag).resolveForShell(cmd);
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
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const sentinel = issue(bag, "value");
      const cmd = 'echo "hello" ' + sentinel;
      const result = loaded(bag).resolveForShell(cmd);
      assertEquals(
        result.command,
        'echo "hello" "${__SWAMP_VAULT_0}"',
      );
    },
  );

  await t.step(
    "resolveForShell: respects escaped quotes",
    () => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const sentinel = issue(bag, "val");
      // \" does not open a quoted section
      const cmd = 'echo \\"' + sentinel;
      const result = loaded(bag).resolveForShell(cmd);
      assertEquals(
        result.command,
        'echo \\"' + '"${__SWAMP_VAULT_0}"',
      );
    },
  );

  await t.step(
    "resolveForPowerShell: replaces sentinel with $env: reference",
    () => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const sentinel = issue(bag, "my-password");
      const result = loaded(bag).resolveForPowerShell(
        `Write-Output ${sentinel}`,
      );
      assertEquals(result.command, 'Write-Output "$env:__SWAMP_VAULT_0"');
      assertEquals(result.env, { __SWAMP_VAULT_0: "my-password" });
    },
  );

  await t.step("resolveForPowerShell: handles multiple secrets", () => {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const s1 = issue(bag, "user");
    const s2 = issue(bag, "pass");
    const cmd = `Connect-Service -User ${s1} -Pass ${s2}`;
    const result = loaded(bag).resolveForPowerShell(cmd);
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
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const sentinel = issue(bag, "token");
      const cmd = `Write-Output "auth: ${sentinel}"`;
      const result = loaded(bag).resolveForPowerShell(cmd);
      assertEquals(
        result.command,
        'Write-Output "auth: $env:__SWAMP_VAULT_0"',
      );
    },
  );

  await t.step(
    "resolveForPowerShell: skips secrets not in command",
    () => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      issue(bag, "unused");
      const sentinel = issue(bag, "present");
      const cmd = `Write-Output ${sentinel}`;
      const result = loaded(bag).resolveForPowerShell(cmd);
      // The unused secret never gets a __SWAMP_VAULT_N slot.
      assertEquals(result.command, 'Write-Output "$env:__SWAMP_VAULT_0"');
      assertEquals(result.env, { __SWAMP_VAULT_0: "present" });
    },
  );

  await t.step(
    "resolveForPowerShell: no secrets returns original command",
    () => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const result = loaded(bag).resolveForPowerShell("Write-Output hello");
      assertEquals(result.command, "Write-Output hello");
      assertEquals(result.env, {});
    },
  );

  await t.step(
    "resolveForShell singleQuoted: detects sentinel inside single quotes",
    () => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const sentinel = issue(bag, "secret");
      const cmd = `S='${sentinel}'`;
      const found = loaded(bag).resolveForShell(cmd).singleQuoted;
      assertEquals(found, [sentinel]);
    },
  );

  await t.step(
    "resolveForShell singleQuoted: does not flag sentinel in double quotes",
    () => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const sentinel = issue(bag, "secret");
      const cmd = `D="${sentinel}"`;
      const found = loaded(bag).resolveForShell(cmd).singleQuoted;
      assertEquals(found, []);
    },
  );

  await t.step(
    "resolveForShell singleQuoted: does not flag unquoted sentinel",
    () => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const sentinel = issue(bag, "secret");
      const cmd = `echo ${sentinel}`;
      const found = loaded(bag).resolveForShell(cmd).singleQuoted;
      assertEquals(found, []);
    },
  );

  await t.step(
    "resolveForShell singleQuoted: detects only the single-quoted one among mixed",
    () => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const s1 = issue(bag, "good");
      const s2 = issue(bag, "bad");
      const cmd = `D="${s1}"\nS='${s2}'`;
      const found = loaded(bag).resolveForShell(cmd).singleQuoted;
      assertEquals(found, [s2]);
    },
  );

  await t.step(
    "resolveForShell singleQuoted: returns empty when no secrets exist",
    () => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const found = loaded(bag).resolveForShell("echo 'hello'").singleQuoted;
      assertEquals(found, []);
    },
  );

  await t.step(
    "resolveForShell singleQuoted: handles multi-line scripts",
    () => {
      const bag = new VaultSecretBag(new SecretBagRegistry());
      const sentinel = issue(bag, "secret");
      const cmd = `#!/bin/sh\necho "safe"\nBROKEN='${sentinel}'\necho done`;
      const found = loaded(bag).resolveForShell(cmd).singleQuoted;
      assertEquals(found, [sentinel]);
    },
  );
});

Deno.test("VaultSecretBag.sentinelizeText: replaces data secrets with one reused sentinel", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const text = bag.sentinelizeText("a=s3cret b=s3cret", entries("s3cret"));
  const sentinels = text.match(VaultSecretBag.SENTINEL_PATTERN) ?? [];
  assertEquals(sentinels.length, 2);
  assertEquals(sentinels[0], sentinels[1]);
  assertEquals(bag.entryOf(sentinels[0] ?? "")?.dataOrigin, true);
  assertEquals(loaded(bag).resolveRaw(text), "a=s3cret b=s3cret");
});

Deno.test("VaultSecretBag.sentinelizeText: JSON-escaped forms restore the escaped text", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const secret = 'pa"ss\nword';
  const json = JSON.stringify({ p: secret }, null, 2);
  const text = bag.sentinelizeText(json, entries(secret));
  assertEquals(text.includes("pa\\"), false);
  // Restoring yields valid JSON carrying the original secret.
  assertEquals(JSON.parse(loaded(bag).resolveRaw(text)).p, secret);
});

Deno.test("VaultSecretBag.sentinelizeText: never searches inside existing sentinels", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const vaultSentinel = issue(bag, "from-vault");
  const text = bag.sentinelizeText(`${vaultSentinel} VSE`, entries("VSE"));
  assertEquals(text.startsWith(vaultSentinel), true);
  assertEquals(loaded(bag).resolveRaw(text), "from-vault VSE");
});

Deno.test("VaultSecretBag.sentinelizeText: longer secrets are replaced before shorter overlaps", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const text = bag.sentinelizeText("abcdef abc", entries("abcdef", "abc"));
  assertEquals(loaded(bag).resolveRaw(text), "abcdef abc");
  assertEquals((text.match(VaultSecretBag.SENTINEL_PATTERN) ?? []).length, 2);
});

Deno.test("VaultSecretBag.sentinelizeValues: resolveDeep round-trips any structure", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 3, maxLength: 12 }), {
        minLength: 1,
        maxLength: 3,
      }),
      fc.jsonValue(),
      (secrets, data) => {
        const bag = new VaultSecretBag(new SecretBagRegistry());
        const sorted = [...secrets].sort((a, b) => b.length - a.length);
        const embedded = { data, text: `x${secrets.join("|")}y` };
        const sentinelized = bag.sentinelizeValues(
          embedded,
          entries(...sorted),
        );
        assertEquals(
          JSON.stringify(loaded(bag).resolveDeep(sentinelized)),
          JSON.stringify(embedded),
        );
      },
    ),
  );
});

Deno.test("VaultSecretBag.resolveForShell: places data-origin references per occurrence", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = bag.addDataSecret("s3cret", REF);
  const resolved = loaded(bag).resolveForShell(
    `echo ${s} "${s}" '${s}' $'a${s}'\ncat <<EOF\n${s}\nEOF`,
  );
  assertEquals(
    resolved.command,
    `echo "\${__SWAMP_VAULT_0}" "\${__SWAMP_VAULT_0}" ''"\${__SWAMP_VAULT_0}"'' ` +
      `$'a'"\${__SWAMP_VAULT_0}"$''\ncat <<EOF\n\${__SWAMP_VAULT_0}\nEOF`,
  );
  assertEquals(resolved.env, { __SWAMP_VAULT_0: "s3cret" });
  assertEquals(resolved.dataInCommandLine, false);
});

Deno.test("VaultSecretBag.resolveForShell: a quoted heredoc keeps the data value and says so", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = bag.addDataSecret("s3cret", REF);
  const resolved = loaded(bag).resolveForShell(`cat <<'EOF'\n${s}\nEOF`);
  assertEquals(resolved.command, "cat <<'EOF'\ns3cret\nEOF");
  assertEquals(resolved.env, {});
  assertEquals(resolved.dataInCommandLine, true);
});

Deno.test("VaultSecretBag.resolveForShell: places vault.get references per occurrence", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "two  words *");
  const ref = "${__SWAMP_VAULT_0}";
  const cases: [string, string][] = [
    // Single-quoted first: the double-quoted use still expands as one word.
    [`b='${s}'; set -- "${s}"`, `b='"${ref}"'; set -- "${ref}"`],
    // Double-quoted first: the single-quoted use is quoted for its own spot.
    [`a="${s}"; b='${s}'`, `a="${ref}"; b='"${ref}"'`],
    // Unquoted first: the double-quoted use is not left unquoted.
    [`echo ${s} "${s}"`, `echo "${ref}" "${ref}"`],
    [
      `echo "${s}" ${s} '${s}' "x${s}y"`,
      `echo "${ref}" "${ref}" '"${ref}"' "x${ref}y"`,
    ],
  ];
  for (const [command, expected] of cases) {
    const resolved = loaded(bag).resolveForShell(command);
    assertEquals(resolved.command, expected);
    assertEquals(resolved.env, { __SWAMP_VAULT_0: "two  words *" });
  }
});

Deno.test("VaultSecretBag.resolveForPowerShell: places vault.get references per occurrence", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "two  words *");
  assertEquals(
    loaded(bag).resolveForPowerShell(`$b='${s}'; Write-Output "${s}"`).command,
    `$b='"$env:__SWAMP_VAULT_0"'; Write-Output "$env:__SWAMP_VAULT_0"`,
  );
  assertEquals(
    loaded(bag).resolveForPowerShell(`Write-Output "${s}" ${s}`).command,
    `Write-Output "$env:__SWAMP_VAULT_0" "$env:__SWAMP_VAULT_0"`,
  );
});

Deno.test("VaultSecretBag.resolveForShell: an apostrophe in a comment does not change a later vault.get placement", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "two  words *");
  const resolved = loaded(bag).resolveForShell(
    `printf '[%s]\\n' "A=${s}"\n# don't log it\nprintf '[%s]\\n' "B=${s}"`,
  );
  assertEquals(
    resolved.command,
    `printf '[%s]\\n' "A=\${__SWAMP_VAULT_0}"\n# don't log it\n` +
      `printf '[%s]\\n' "B=\${__SWAMP_VAULT_0}"`,
  );
  assertEquals(resolved.singleQuoted, []);
});

Deno.test("VaultSecretBag.resolveForShell: vault.get in a here-document body follows the quotes before it", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "v");
  const resolved = loaded(bag).resolveForShell(
    `cat <<EOF\n{"k": "${s}"}\nraw ${s}\nEOF\ncat <<'END'\n${s}\nEND`,
  );
  assertEquals(
    resolved.command,
    `cat <<EOF\n{"k": "\${__SWAMP_VAULT_0}"}\nraw "\${__SWAMP_VAULT_0}"\nEOF\n` +
      `cat <<'END'\n"\${__SWAMP_VAULT_0}"\nEND`,
  );
  assertEquals(resolved.singleQuoted, []);
});

Deno.test("VaultSecretBag.resolveForShell: vault.get on a continuation line of a here-document string stays bare", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "v");
  const resolved = loaded(bag).resolveForShell(
    `cat <<EOF > run.sh\necho "line1\n${s}"\nEOF`,
  );
  assertEquals(
    resolved.command,
    `cat <<EOF > run.sh\necho "line1\n\${__SWAMP_VAULT_0}"\nEOF`,
  );
  assertEquals(resolved.singleQuoted, []);
});

Deno.test("VaultSecretBag.resolveForShell: quotes before a here-document do not change placement in its body", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "v");
  const ref = "${__SWAMP_VAULT_0}";
  const cases: [string, string][] = [
    [
      `# don't log this\ncat <<EOF > cfg.json\n{"k": "${s}"}\nEOF`,
      `# don't log this\ncat <<EOF > cfg.json\n{"k": "${ref}"}\nEOF`,
    ],
    [
      `cat <<A\nit's\nA\ncat <<B\n{"k": "${s}"}\nB`,
      `cat <<A\nit's\nA\ncat <<B\n{"k": "${ref}"}\nB`,
    ],
    [
      `\ncat <<EOF\necho "a\n${s}"\nEOF`,
      `\ncat <<EOF\necho "a\n${ref}"\nEOF`,
    ],
  ];
  for (const [command, expected] of cases) {
    const resolved = loaded(bag).resolveForShell(command);
    assertEquals(resolved.command, expected);
    assertEquals(resolved.singleQuoted, []);
  }
});

Deno.test("VaultSecretBag.resolveForShell: apostrophes in here-document prose do not change placement", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "v");
  const ref = "${__SWAMP_VAULT_0}";
  const cases: [string, string][] = [
    [
      `cat <<EOF\nit's here\n{"k": "${s}"}\nEOF`,
      `cat <<EOF\nit's here\n{"k": "${ref}"}\nEOF`,
    ],
    [
      `cat <<EOF > app.env\n# Don't commit this file\nDB_PASSWORD="${s}"\nEOF`,
      `cat <<EOF > app.env\n# Don't commit this file\nDB_PASSWORD="${ref}"\nEOF`,
    ],
    [
      `cat <<EOF\nit's "a \\" b"\necho "x\n${s}"\nEOF`,
      `cat <<EOF\nit's "a \\" b"\necho "x\n${ref}"\nEOF`,
    ],
  ];
  for (const [command, expected] of cases) {
    const resolved = loaded(bag).resolveForShell(command);
    assertEquals(resolved.command, expected);
    assertEquals(resolved.singleQuoted, []);
  }
});

Deno.test("VaultSecretBag.resolveForShell: a double quote inside single quotes on a here-document line opens no string", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "v");
  const quoted = `"\${__SWAMP_VAULT_0}"`;
  for (
    const line of [
      `tr -d '"' < in > out`,
      `sed 's/"//g' f`,
      `IFS='"'`,
      `grep -c '"' f`,
      `awk -F'"' '{print $2}' f`,
    ]
  ) {
    assertEquals(
      loaded(bag).resolveForShell(
        `cat <<EOF > gen.sh\n${line}\nset -- ${s}\nEOF`,
      )
        .command,
      `cat <<EOF > gen.sh\n${line}\nset -- ${quoted}\nEOF`,
    );
  }
});

Deno.test("VaultSecretBag.resolveForShell: mid-word quotes in here-document prose open no string", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "v");
  const ref = "\${__SWAMP_VAULT_0}";
  const cases: [string, string][] = [
    [
      `cat <<EOF\nscreen is 5" wide\nPASS=${s}\nEOF`,
      `cat <<EOF\nscreen is 5" wide\nPASS="${ref}"\nEOF`,
    ],
    [
      `cat <<EOF\ndon't say "it's" twice\nKEY="${s}"\nEOF`,
      `cat <<EOF\ndon't say "it's" twice\nKEY="${ref}"\nEOF`,
    ],
  ];
  for (const [command, expected] of cases) {
    assertEquals(loaded(bag).resolveForShell(command).command, expected);
  }
});

Deno.test("VaultSecretBag.resolveForShell: here-document strings attached to other text pair up on their line", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "v");
  const ref = "${__SWAMP_VAULT_0}";
  for (
    const [line, expected] of [
      [`mysql -u root -p"${s}" db`, `mysql -u root -p"${ref}" db`],
      [`curl -H"Authorization: ${s}" x`, `curl -H"Authorization: ${ref}" x`],
      [`cmd >"${s}"`, `cmd >"${ref}"`],
      [`echo \${A}"${s}"`, `echo \${A}"${ref}"`],
      [`echo 'prefix: '"${s}"`, `echo 'prefix: '"${ref}"`],
      [`echo "a""${s}"`, `echo "a""${ref}"`],
      [`echo $(x)"${s}"`, `echo $(x)"${ref}"`],
      [`echo foo"bar ${s}"`, `echo foo"bar ${ref}"`],
    ]
  ) {
    assertEquals(
      loaded(bag).resolveForShell(`cat <<EOF > gen.sh\n${line}\nEOF`).command,
      `cat <<EOF > gen.sh\n${expected}\nEOF`,
    );
  }
});

Deno.test("VaultSecretBag.resolveForShell: a vault.get use inside single quotes in a here-document stays bare", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "v");
  assertEquals(
    loaded(bag).resolveForShell(`cat <<EOF > gen.sh\nPASS='${s}'\nEOF`).command,
    `cat <<EOF > gen.sh\nPASS='\${__SWAMP_VAULT_0}'\nEOF`,
  );
});

Deno.test("VaultSecretBag.resolveForShell: a single quote attached mid-word does not shield a double quote on the same here-document line", () => {
  // Known limit (swamp-club#3106): -F'"' starts no single-quoted span, so its
  // double quote opens a string for the rest of that line only.
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "v");
  assertEquals(
    loaded(bag).resolveForShell(
      `cat <<EOF > gen.sh\nawk -F'"' -v k=${s} f\nset -- ${s}\nEOF`,
    )
      .command,
    `cat <<EOF > gen.sh\nawk -F'"' -v k=\${__SWAMP_VAULT_0} f\nset -- "\${__SWAMP_VAULT_0}"\nEOF`,
  );
});

Deno.test("VaultSecretBag.resolveForShell: singleQuoted leaves out data-origin sentinels", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const data = bag.addDataSecret("from-data", REF);
  const vault = issue(bag, "from-vault");
  assertEquals(
    loaded(bag).resolveForShell(`echo '${data}' '${vault}'`).singleQuoted,
    [vault],
  );
});

Deno.test("VaultSecretBag.resolveForPowerShell: singleQuoted lists a single-quoted vault.get use", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "from-vault");
  assertEquals(
    loaded(bag).resolveForPowerShell(`Write-Output "${s}" '${s}'`).singleQuoted,
    [s],
  );
  assertEquals(
    loaded(bag).resolveForPowerShell(`Write-Output "${s}"`).singleQuoted,
    [],
  );
});

Deno.test("VaultSecretBag.resolveForShell: singleQuoted finds a single-quoted use after a double-quoted one", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "from-vault");
  assertEquals(loaded(bag).resolveForShell(`a="${s}"; b='${s}'`).singleQuoted, [
    s,
  ]);
  assertEquals(
    loaded(bag).resolveForShell(`echo ${s} '${s}' '${s}'`).singleQuoted,
    [
      s,
    ],
  );
  assertEquals(
    loaded(bag).resolveForShell(`echo ${s} "${s}"`).singleQuoted,
    [],
  );
});

Deno.test("VaultSecretBag.resolveForPowerShell: single-quoted data values stay in place", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = bag.addDataSecret("s3cret", REF);
  const resolved = loaded(bag).resolveForPowerShell(
    `Write-Output '${s}' "${s}"`,
  );
  assertEquals(
    resolved.command,
    `Write-Output 's3cret' "$env:__SWAMP_VAULT_0"`,
  );
  assertEquals(resolved.dataInCommandLine, true);
});

Deno.test("VaultSecretBag.resolveForShell: drops the env entry of a value kept in the command line, even beside a longer env name", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinels = Array.from(
    { length: 11 },
    (_, i) => bag.addDataSecret(`secret-value-${i}`, REF),
  );
  // Sentinel 1 sits in a quoted heredoc (kept in place); sentinel 10's
  // reference name contains "__SWAMP_VAULT_1" as a prefix.
  const command = sentinels
    .filter((_, i) => i !== 1)
    .map((s) => `echo "${s}"`)
    .join("; ") + `\ncat <<'EOF'\n${sentinels[1]}\nEOF`;
  const resolved = loaded(bag).resolveForShell(command);
  assertEquals(resolved.dataInCommandLine, true);
  assertEquals(
    Object.values(resolved.env).includes("secret-value-1"),
    false,
  );
  assertEquals(Object.keys(resolved.env).length, 10);
});

Deno.test("VaultSecretBag.fromEntries: a rebuilt bag resolves exactly like the original", () => {
  const original = new VaultSecretBag(new SecretBagRegistry());
  const vaultSentinel = issue(original, "vault-pa$$ word");
  const dataSentinel = original.addDataSecret("data-secret", REF);
  const escaped = original.sentinelizeText('{"k":"a\\"b"}', entries('a"b'));
  const command =
    `echo "${vaultSentinel}" ${dataSentinel} '${vaultSentinel}'\ncat <<'EOF'\n${dataSentinel}\nEOF\necho ${escaped}`;

  const rebuilt = VaultSecretBag.fromEntries(loaded(original).toEntries());

  assertEquals(loaded(rebuilt).toEntries(), loaded(original).toEntries());
  assertEquals(
    loaded(rebuilt).resolveForShell(command),
    loaded(original).resolveForShell(command),
  );
  assertEquals(
    loaded(rebuilt).resolveForPowerShell(command),
    loaded(original).resolveForPowerShell(command),
  );
  assertEquals(
    loaded(rebuilt).resolveDeep({ run: command, list: [dataSentinel] }),
    loaded(original).resolveDeep({ run: command, list: [dataSentinel] }),
  );
  assertEquals(rebuilt.entryOf(dataSentinel)?.dataOrigin, true);
  assertEquals(rebuilt.entryOf(vaultSentinel)?.dataOrigin, false);
});

Deno.test("VaultSecretBag.fromEntries: reuses a shipped data sentinel for the same value", () => {
  const original = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = original.addDataSecret("data-secret", REF);
  const rebuilt = VaultSecretBag.fromEntries(loaded(original).toEntries());
  assertEquals(rebuilt.addDataSecret("data-secret", REF), sentinel);
  assertEquals(loaded(rebuilt).toEntries().length, 1);
});

Deno.test("VaultSecretBag.fromEntries: rejects a malformed sentinel", () => {
  assertThrows(
    () =>
      VaultSecretBag.fromEntries([
        { sentinel: "$(id)", value: "x", dataOrigin: false },
      ]),
    Error,
    "Malformed vault secret sentinel",
  );
});

Deno.test("VaultSecretBag.toEntries: an empty bag has no entries", () => {
  assertEquals(new VaultSecretBag(new SecretBagRegistry()).toEntries(), []);
  assertEquals(VaultSecretBag.fromEntries([]).isEmpty, true);
});

Deno.test("VaultSecretBag: a view resolves a sentinel another bag of the run issued, and reports only its own", () => {
  const registry = new SecretBagRegistry();
  const runStart = new VaultSecretBag(registry);
  const step = new VaultSecretBag(registry);
  const early = runStart.addDataSecret("early-secret", REF);
  assertEquals(step.isEmpty, true);
  assertEquals(step.resolvesAny, true);
  assertEquals(loaded(step).resolveRaw(`echo ${early}`), "echo early-secret");
  assertEquals(loaded(step).resolveDeep({ a: [early] }), {
    a: ["early-secret"],
  });
  assertEquals(loaded(step).resolveForShell(`echo ${early}`).env, {
    __SWAMP_VAULT_0: "early-secret",
  });
  assertEquals(loaded(step).toEntries(), []);
  assertEquals(loaded(step).rawValues, []);
  const own = issue(step, "own-secret");
  assertEquals(loaded(step).toEntries(), [{
    sentinel: own,
    value: "own-secret",
    dataOrigin: false,
  }]);
  assertEquals(loaded(runStart).resolveRaw(own), "own-secret");
});

Deno.test("VaultSecretBag.entriesFor: the bag's own entries, then the run's entries the arguments carry", () => {
  const registry = new SecretBagRegistry();
  const runStart = new VaultSecretBag(registry);
  const step = new VaultSecretBag(registry);
  const early = runStart.addDataSecret("early-secret", REF);
  const unused = issue(runStart, "unused-secret");
  const own = issue(step, "own-secret");
  assertEquals(
    loaded(step).entriesFor({
      run: `echo ${early}`,
      nested: [{ x: `${own} ${early}` }],
    }),
    [
      { sentinel: own, value: "own-secret", dataOrigin: false },
      { sentinel: early, value: "early-secret", dataOrigin: true },
    ],
  );
  assertEquals(
    loaded(step).entriesFor({ run: "plain" }),
    loaded(step).toEntries(),
  );
  assertEquals(
    loaded(step).entriesFor(unused).some((entry) => entry.sentinel === unused),
    true,
  );
  assertEquals(new VaultSecretBag(registry).entriesFor({}), []);
});

Deno.test("VaultSecretBag.referencesFor: the references behind the sentinels the arguments carry, whichever bag issued them, loaded or not (swamp-club#3529)", () => {
  const registry = new SecretBagRegistry();
  const runStart = new VaultSecretBag(registry);
  const step = new VaultSecretBag(registry);
  const early = runStart.addDataSecret("early-secret", {
    vaultName: "v",
    key: "early",
  });
  issue(runStart, "unused");
  const own = issue(step, "own");
  issue(step, "other-method");
  const args = { run: `echo ${early}`, nested: [{ x: `${own} ${early}` }] };
  const expected = [
    { vaultName: "v", key: "early" },
    { vaultName: "v", key: "own" },
  ];
  // The same list before and after a load: a reference no attempt loaded
  // is listed, not thrown on. The reference the arguments do not carry
  // (other-method) is not.
  assertEquals(step.referencesFor(args), expected);
  assertEquals(loaded(step).referencesFor(args), expected);
  assertEquals(step.referencesFor({ run: "plain" }), []);
  assertEquals(new VaultSecretBag(registry).referencesFor({}), []);
});

Deno.test("VaultSecretBag.referencesFor: one reference per vault and key, and an entry without a reference is skipped", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const first = bag.addSecret({ vaultName: "v", key: "k" }, "a");
  const second = bag.addSecret({ vaultName: "v", key: "k" }, "b");
  assertEquals(bag.referencesFor([first, second]), [
    { vaultName: "v", key: "k" },
  ]);
  // A worker's rebuilt bag holds values without references.
  const rebuilt = VaultSecretBag.fromEntries([
    { sentinel: first, value: "x", dataOrigin: false },
  ]);
  assertEquals(rebuilt.referencesFor({ run: first }), []);
});

Deno.test("VaultSecretBag.toEntries: ships no reference and no encoding", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addDataSecret('a"b', REF, "json");
  assertEquals(loaded(bag).toEntries(), [{
    sentinel,
    value: 'a"b',
    dataOrigin: true,
  }]);
  assertEquals(Object.keys(loaded(bag).toEntries()[0]).sort(), [
    "dataOrigin",
    "sentinel",
    "value",
  ]);
  const entry = bag.entryOf(sentinel)!;
  assertEquals("reference" in entry && entry.reference, REF);
  assertEquals("encoding" in entry && entry.encoding, "json");
});

Deno.test("VaultSecretBag.rehomeSentinels: vault-origin entries are re-issued once per sentinel, data-origin ones once per value", () => {
  const registry = new SecretBagRegistry();
  const source = new VaultSecretBag(registry);
  const target = new VaultSecretBag(registry);
  const vault = issue(source, "vault-secret");
  const data = source.addDataSecret("data-secret", {
    vaultName: "v",
    key: "d",
  });
  const other = issue(new VaultSecretBag(registry), "other");
  const rehomed = source.rehomeSentinels(
    { run: `${vault} ${vault} ${data} ${data} ${other}` },
    target,
  ) as { run: string };
  const [v1, v2, d1, d2, o] = rehomed.run.split(" ");
  assertEquals(v1, v2);
  assertEquals(d1, d2);
  assertEquals(o, other);
  assertEquals(v1 !== vault && d1 !== data, true);
  assertEquals(loaded(target).toEntries().length, 2);
  assertEquals(target.entryOf(v1)?.dataOrigin, false);
  assertEquals(target.entryOf(d1)?.dataOrigin, true);
  assertEquals(registry.issuedEntryOf(d1)?.reference, {
    vaultName: "v",
    key: "d",
  });
  assertEquals(
    loaded(target).resolveRaw(rehomed.run),
    loaded(source).resolveRaw(`${vault} ${vault} ${data} ${data} ${other}`),
  );
  assertEquals(loaded(target).resolveForShell(rehomed.run).env, {
    __SWAMP_VAULT_0: "other",
    __SWAMP_VAULT_1: "vault-secret",
    __SWAMP_VAULT_2: "data-secret",
  });
});

Deno.test("VaultSecretBag.rehomeSentinels: a shipped entry without a reference cannot be rehomed", () => {
  const shipped = VaultSecretBag.fromEntries([{
    sentinel: `__SWAMP_VSEC_${"ab".repeat(16)}_0__`,
    value: "x",
    dataOrigin: false,
  }]);
  const target = new VaultSecretBag(new SecretBagRegistry());
  assertThrows(
    () =>
      shipped.rehomeSentinels(
        `__SWAMP_VSEC_${"ab".repeat(16)}_0__`,
        target,
      ),
    Error,
    "without a reference",
  );
});

Deno.test("VaultSecretBag.addSecret: a vault reference holds no value, only its reference and location", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addSecret(REF, "methods.run.arguments.cmd");
  assertEquals(bag.registry.entryOf(sentinel), {
    sentinel,
    reference: REF,
    encoding: "raw",
    dataOrigin: false,
    location: "methods.run.arguments.cmd",
  });
});

Deno.test("VaultSecretBag: an unloaded vault reference fails delivery instead of passing its sentinel", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addSecret(REF, "methods.run.arguments.cmd");
  const deliveries: [string, () => unknown][] = [
    ["resolveRaw", () => bag.resolveRaw(`x ${sentinel}`)],
    ["resolveDeep", () => bag.resolveDeep({ a: [sentinel] })],
    ["resolveForShell", () => bag.resolveForShell(`echo ${sentinel}`)],
    ["resolveForPowerShell", () => bag.resolveForPowerShell(sentinel)],
    ["entriesFor", () => bag.entriesFor({ a: sentinel })],
  ];
  for (const [name, deliver] of deliveries) {
    const error = assertThrows(deliver, Error, "was not loaded", name);
    assertEquals(error.message.includes("'k'"), true, name);
    assertEquals(error.message.includes("methods.run.arguments.cmd"), true);
  }
  // Nothing of it is delivered or shipped while it is unloaded.
  assertEquals(bag.toEntries(), []);
  assertEquals(bag.rawValues, []);
});

Deno.test("VaultSecretBag.withLoaded: the view delivers the loaded value, and the bag stays unloaded", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addSecret(REF, "loc");
  const data = bag.addDataSecret("from-data", REF);
  const view = bag.withLoaded(new Map([[sentinel, "loaded-value"]]));
  assertEquals(
    view.resolveRaw(`${sentinel} ${data}`),
    "loaded-value from-data",
  );
  assertEquals(view.toEntries(), [
    { sentinel, value: "loaded-value", dataOrigin: false },
    { sentinel: data, value: "from-data", dataOrigin: true },
  ]);
  assertEquals(view.isEmpty, false);
  assertThrows(() => bag.resolveRaw(sentinel), Error, "was not loaded");
  // A second attempt's view loads its own value.
  assertEquals(
    bag.withLoaded(new Map([[sentinel, "rotated"]])).resolveRaw(sentinel),
    "rotated",
  );
  assertThrows(() => view.addSecret(REF, "loc"), Error, "issues no sentinels");
  assertThrows(
    () => view.addDataSecret("new", REF),
    Error,
    "issues no sentinels",
  );
});

Deno.test("VaultSecretBag.entriesFor: an own vault reference the attempt did not load is not shipped", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const delivered = bag.addSecret({ vaultName: "v", key: "used" }, "a");
  bag.addSecret({ vaultName: "v", key: "other-method" }, "b");
  const view = bag.withLoaded(new Map([[delivered, "used-value"]]));
  assertEquals(view.entriesFor({ run: delivered }), [
    { sentinel: delivered, value: "used-value", dataOrigin: false },
  ]);
});

Deno.test("VaultSecretBag.rehomeSentinels: a vault reference moves with its location and no value", () => {
  const registry = new SecretBagRegistry();
  const source = new VaultSecretBag(registry);
  const target = new VaultSecretBag(registry);
  const sentinel = source.addSecret(REF, "inputs.token");
  const rehomed = source.rehomeSentinels(sentinel, target) as string;
  assertEquals(registry.entryOf(rehomed), {
    sentinel: rehomed,
    reference: REF,
    encoding: "raw",
    dataOrigin: false,
    location: "inputs.token",
  });
});

Deno.test("VaultSecretBag: a bag draws its prefix when it first issues", () => {
  const registry = new SecretBagRegistry();
  const bag = new VaultSecretBag(registry);
  const sentinel = bag.addSecret(REF, "loc");
  assertEquals(registry.drewPrefixOf(sentinel), true);
  // A delivery view issues nothing, so it draws no prefix of its own.
  bag.withLoaded(new Map());
  assertEquals(registry.drewPrefixOf(sentinel), true);
});

Deno.test("VaultSecretBag.addDataSecret: two references with one value share the first reference", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const first = bag.addDataSecret("same", { vaultName: "v", key: "a" });
  const second = bag.addDataSecret("same", { vaultName: "v", key: "b" });
  assertEquals(first, second);
  assertEquals(bag.registry.issuedEntryOf(first)?.reference, {
    vaultName: "v",
    key: "a",
  });
});

// --- typed-secrets 3.3: value-less data-origin references ---

const DATA_LOCATION =
  "data.latest of model 'db' record r1 version 2 (data.latest), field 'password'";

Deno.test("VaultSecretBag.addDataReference: a data-origin reference holds no value, only its reference and where it was read", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addDataReference(REF, DATA_LOCATION);
  assertEquals(bag.registry.entryOf(sentinel), {
    sentinel,
    reference: REF,
    encoding: "raw",
    dataOrigin: true,
    location: DATA_LOCATION,
  });
  assertEquals(bag.rawValues, []);
  assertEquals(bag.toEntries(), []);
  assertEquals(bag.isEmpty, false);
  // Two reads of one reference are two sentinels: no value is known to
  // share by, unlike addDataSecret.
  assertEquals(bag.addDataReference(REF, DATA_LOCATION) !== sentinel, true);
});

Deno.test("VaultSecretBag: an unloaded data-origin reference is never delivered as a value, and the error names where it was read", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addDataReference(REF, DATA_LOCATION);
  for (
    const read of [
      () => bag.resolveRaw(sentinel),
      () => bag.resolveForShell(`echo ${sentinel}`),
      () => bag.resolveForPowerShell(`echo ${sentinel}`),
      () => bag.entriesFor({ run: sentinel }),
    ]
  ) {
    const error = assertThrows(read, Error, "was not loaded before delivery");
    assertEquals(error.message.includes(DATA_LOCATION), true);
  }
});

Deno.test("VaultSecretBag: a loaded data-origin reference delivers as a data value, through the environment on both shells", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addDataReference(REF, DATA_LOCATION);
  const view = bag.withLoaded(new Map([[sentinel, "loaded-value"]]));
  assertEquals(view.resolveRaw(`x=${sentinel}`), "x=loaded-value");
  assertEquals(view.resolveDeep({ run: sentinel }), { run: "loaded-value" });
  assertEquals(view.resolveForShell(`echo ${sentinel} "${sentinel}"`), {
    command: 'echo "${__SWAMP_VAULT_0}" "${__SWAMP_VAULT_0}"',
    env: { __SWAMP_VAULT_0: "loaded-value" },
    dataInCommandLine: false,
    singleQuoted: [],
    envNames: new Map([[sentinel, "__SWAMP_VAULT_0"]]),
  });
  // A quoted here-document is placed as a data entry's value is placed
  // today, and says so (typed-secrets 3.4 turns it into a refusal).
  const heredoc = view.resolveForShell(`cat <<'EOF'\n${sentinel}\nEOF`);
  assertEquals(heredoc.dataInCommandLine, true);
  assertEquals(heredoc.command.includes("loaded-value"), true);
  assertEquals(
    view.resolveForPowerShell(`echo ${sentinel}`).command,
    'echo "$env:__SWAMP_VAULT_0"',
  );
  const shipped = { sentinel, value: "loaded-value", dataOrigin: true };
  assertEquals(view.toEntries(), [shipped]);
  assertEquals(view.entriesFor({ run: sentinel }), [shipped]);
  assertEquals(
    VaultSecretBag.fromEntries(view.toEntries()).resolveRaw(sentinel),
    "loaded-value",
  );
  // The bag itself still holds nothing.
  assertEquals(bag.rawValues, []);
  assertEquals(bag.toEntries(), []);
});

Deno.test("VaultSecretBag.rehomeSentinels: a data-origin reference moves as a reference, with its location and no value", () => {
  const registry = new SecretBagRegistry();
  const source = new VaultSecretBag(registry);
  const target = new VaultSecretBag(registry);
  const sentinel = source.addDataReference(REF, DATA_LOCATION);
  const rehomed = source.rehomeSentinels(
    `a ${sentinel} ${sentinel}`,
    target,
  ) as string;
  const [r1, r2] = rehomed.match(VaultSecretBag.SENTINEL_PATTERN)!;
  assertEquals(r1, r2);
  assertEquals(r1 !== sentinel, true);
  assertEquals(registry.entryOf(r1), {
    sentinel: r1,
    reference: REF,
    encoding: "raw",
    dataOrigin: true,
    location: DATA_LOCATION,
  });
  assertEquals(target.rawValues, []);
});

Deno.test("planShellPlacement: plans every occurrence from references alone, with no value loaded (typed-secrets 3.4)", () => {
  const registry = new SecretBagRegistry();
  const bag = new VaultSecretBag(registry);
  const data = bag.addDataReference(REF, "db/main.password");
  const vault = issue(bag, "two words");
  const command =
    `echo ${data} '${vault}' "${vault}"\ncat <<'EOF'\n${data}\nEOF`;
  const plan = planShellPlacement(
    command,
    [],
    secretOccurrencesOf(registry).originOf,
  );
  assertEquals(
    plan.occurrences.map((o) => [o.placement, o.text ?? o.where]),
    [
      ["environment", '"${__SWAMP_VAULT_0}"'],
      ["literal", '"${__SWAMP_VAULT_1}"'],
      ["environment", "${__SWAMP_VAULT_1}"],
      ["refused", "a here-document with a quoted delimiter"],
    ],
  );
  assertEquals(plan.singleQuoted, [vault]);
  assertEquals(plan.refused.map((o) => o.sentinel), [data]);
  assertEquals(
    plan.envNames,
    new Map([[data, "__SWAMP_VAULT_0"], [vault, "__SWAMP_VAULT_1"]]),
  );
  for (const occurrence of plan.occurrences) {
    assertEquals(
      command.slice(occurrence.start, occurrence.end),
      occurrence.sentinel,
    );
  }
  // The bag is unloaded: a fill throws where the plan needed nothing.
  assertThrows(() => bag.resolveForShell(command));
});

Deno.test("planShellPlacement and resolveForShell: generated names skip the authored keys exactly, and the resolution reports them", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const s = issue(bag, "v");
  const resolved = loaded(bag).resolveForShell(`echo ${s}`, [
    "__SWAMP_VAULT_0",
    "__swamp_vault_1",
  ]);
  // POSIX names are case-sensitive: the lower-case key is no collision.
  assertEquals(resolved.command, 'echo "${__SWAMP_VAULT_1}"');
  assertEquals(resolved.env, { __SWAMP_VAULT_1: "v" });
  assertEquals(resolved.envNames, new Map([[s, "__SWAMP_VAULT_1"]]));
});

Deno.test("planPowerShellPlacement and resolveForPowerShell: names skip authored keys whatever their case, and a single-quoted data value is refused", () => {
  const registry = new SecretBagRegistry();
  const bag = new VaultSecretBag(registry);
  const data = bag.addDataSecret("s3cret", REF);
  const vault = issue(bag, "v");
  const command = `Write-Output '${data}' ${vault}`;
  const authored = ["__swamp_vault_0", "__SWAMP_VAULT_1"];
  const plan = planPowerShellPlacement(
    command,
    authored,
    secretOccurrencesOf(registry).originOf,
  );
  assertEquals([...plan.envNames.values()], [
    "__SWAMP_VAULT_2",
    "__SWAMP_VAULT_3",
  ]);
  assertEquals(plan.refused.map((o) => o.where), ["PowerShell single quotes"]);
  // The legacy fill pastes what the plan refused, and says so.
  const resolved = loaded(bag).resolveForPowerShell(command, authored);
  assertEquals(
    resolved.command,
    `Write-Output 's3cret' "$env:__SWAMP_VAULT_3"`,
  );
  assertEquals(resolved.dataInCommandLine, true);
  assertEquals(resolved.env, { __SWAMP_VAULT_3: "v" });
});

// --- typed-secrets 4.4: written references keep their encoding ---

Deno.test("VaultSecretBag.addWrittenReference: issues a reference-only entry in the written entry's shape, by encoding and origin", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const data = bag.addWrittenReference(REF, "json", true, "run-1 inputs.body");
  const vault = bag.addWrittenReference(
    REF,
    "number",
    false,
    "run-1 inputs.port",
  );
  assertEquals(bag.registry.entryOf(data), {
    sentinel: data,
    reference: REF,
    encoding: "json",
    dataOrigin: true,
    location: "run-1 inputs.body",
  });
  assertEquals(bag.registry.entryOf(vault), {
    sentinel: vault,
    reference: REF,
    encoding: "number",
    dataOrigin: false,
    location: "run-1 inputs.port",
  });
  // Neither holds a value: a load at delivery reads it.
  assertEquals(bag.toEntries(), []);
});

Deno.test("VaultSecretBag.rehomeSentinels: a written reference keeps its encoding, origin and location, and both sentinels share one identity", () => {
  const registry = new SecretBagRegistry();
  const source = new VaultSecretBag(registry);
  const target = new VaultSecretBag(registry);
  const json = source.addWrittenReference(REF, "json", true, "wf body");
  const number = source.addWrittenReference(REF, "number", false, "wf port");
  const rehomed = source.rehomeSentinels(
    { body: `{"k":"${json}"}`, port: number },
    target,
  ) as { body: string; port: string };
  const [jsonCopy] = rehomed.body.match(VaultSecretBag.SENTINEL_PATTERN)!;
  assertEquals(registry.entryOf(jsonCopy), {
    sentinel: jsonCopy,
    reference: REF,
    encoding: "json",
    dataOrigin: true,
    location: "wf body",
  });
  assertEquals(registry.entryOf(rehomed.port), {
    sentinel: rehomed.port,
    reference: REF,
    encoding: "number",
    dataOrigin: false,
    location: "wf port",
  });
  const identity = sentinelIdentityOf(registry);
  assertEquals(identity(jsonCopy), identity(json));
  assertEquals(identity(rehomed.port), identity(number));
  assertEquals(identity(rehomed.port) === identity(jsonCopy), false);
});

Deno.test("VaultSecretBag: a json written reference delivers the loaded value escaped in text, in the shell environment on both strategies, and in shipped entries", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addWrittenReference(REF, "json", false, "loc");
  const view = bag.withLoaded(new Map([[sentinel, 'p"w\\d']]));
  assertEquals(view.resolveRaw(`{"k":"${sentinel}"}`), '{"k":"p\\"w\\\\d"}');
  assertEquals(view.resolveDeep({ body: `{"k":"${sentinel}"}` }), {
    body: '{"k":"p\\"w\\\\d"}',
  });
  assertEquals(
    Object.values(view.resolveForShell(`echo ${sentinel}`).env),
    ['p\\"w\\\\d'],
  );
  assertEquals(
    Object.values(view.resolveForPowerShell(`echo ${sentinel}`).env),
    ['p\\"w\\\\d'],
  );
  assertEquals(view.toEntries(), [{
    sentinel,
    value: 'p\\"w\\\\d',
    dataOrigin: false,
  }]);
});

Deno.test("VaultSecretBag: a number or boolean written reference delivers its text, at a whole leaf and inside a string, for the trusted boundary's schema to coerce", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const port = bag.addWrittenReference(
    { vaultName: "prod", key: "port" },
    "number",
    false,
    "run-1 inputs.port",
  );
  const flag = bag.addWrittenReference(REF, "boolean", true, "run-1 inputs.on");
  const view = bag.withLoaded(new Map([[port, "8080"], [flag, "true"]]));
  assertEquals(view.resolveDeep({ port, on: flag, text: `p=${port}` }), {
    port: "8080",
    on: "true",
    text: "p=8080",
  });
  assertEquals(view.resolveRaw(port), "8080");
  // A rotated value is delivered as it is: the schema of the field it
  // reaches decides, as for any delivered text.
  const rotated = bag.withLoaded(new Map([[port, "eight"], [flag, "yes"]]));
  assertEquals(rotated.resolveDeep({ port, on: flag }), {
    port: "eight",
    on: "yes",
  });
  // The entries keep their encodings for persistence and identity.
  assertEquals(bag.registry.issuedEntryOf(port)?.encoding, "number");
  assertEquals(bag.registry.issuedEntryOf(flag)?.encoding, "boolean");
});
