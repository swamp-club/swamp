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

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  currentVaultAccess,
  runGeneratorWithVaultAccess,
  RunVaultAccess,
  runWithVaultAccess,
  type VaultAccessDenial,
  VaultAccessDeniedError,
  type VaultAction,
  type VaultPrincipalPolicy,
  withoutVaultAccess,
} from "./run_vault_access.ts";

/** A policy allowing exactly the listed vault/action pairs. */
function policyAllowing(
  principal: string,
  allowed: Record<string, VaultAction[]>,
): VaultPrincipalPolicy & { calls: string[] } {
  const calls: string[] = [];
  return {
    principal,
    calls,
    decide(vaultName, action) {
      calls.push(`${vaultName}:${action}`);
      return allowed[vaultName]?.includes(action)
        ? { allowed: true, grantId: "g-allow", reason: "granted" }
        : { allowed: false, reason: "no grant allows it" };
    },
  };
}

Deno.test("currentVaultAccess: undefined outside any scope", () => {
  assertEquals(currentVaultAccess(), undefined);
});

Deno.test("RunVaultAccess.check: allows a vault on the list and a policy allow", async () => {
  const access = RunVaultAccess.create({
    policy: policyAllowing("user:alice", { erp: ["read"] }),
    allowedVaults: ["erp"],
    allowListSource: "wf",
  });
  await access.check("erp", "read", "k");
});

Deno.test("RunVaultAccess.check: refusal names the vault and principal, never a value", async () => {
  const denials: VaultAccessDenial[] = [];
  const access = RunVaultAccess.create({
    policy: policyAllowing("user:alice", { roomcontrol: ["read"] }),
    onDenied: (d) => {
      denials.push(d);
    },
  });
  const error = await assertRejects(
    () => access.check("erp", "read", "db-password"),
    VaultAccessDeniedError,
  );
  assertStringIncludes(error.message, "'erp'");
  assertStringIncludes(error.message, "user:alice");
  assertEquals(error.message.includes("db-password"), false);
  assertEquals(denials, [{
    vaultName: "erp",
    action: "read",
    principal: "user:alice",
    reason: "no grant allows it",
    secretKey: "db-password",
  }]);
});

Deno.test("RunVaultAccess.check: workflow list refusal names the workflow", async () => {
  const access = RunVaultAccess.create({
    allowedVaults: ["roomcontrol"],
    allowListSource: "deploy",
  });
  const error = await assertRejects(
    () => access.check("erp", "write"),
    VaultAccessDeniedError,
  );
  assertStringIncludes(error.message, "'erp'");
  assertStringIncludes(error.message, "workflow 'deploy'");
  assertEquals(error.denial.workflow, "deploy");
});

Deno.test("RunVaultAccess.check: onDenied is called once per vault, key and action", async () => {
  let calls = 0;
  const access = RunVaultAccess.create({
    allowedVaults: [],
    onDenied: () => {
      calls++;
    },
  });
  for (let i = 0; i < 3; i++) {
    await assertRejects(() => access.check("erp", "read", "k"));
  }
  assertEquals(calls, 1);
  await assertRejects(() => access.check("erp", "write", "k"));
  await assertRejects(() => access.check("erp", "read", "other"));
  assertEquals(calls, 3);
});

Deno.test("runWithVaultAccess: nested allow-lists intersect", async () => {
  const outer = RunVaultAccess.create({ allowedVaults: ["a", "b"] });
  const inner = RunVaultAccess.create({ allowedVaults: ["b", "c"] });
  await runWithVaultAccess(outer, () =>
    runWithVaultAccess(inner, async () => {
      const access = currentVaultAccess()!;
      assertEquals([...access.allowedVaults!], ["b"]);
      await access.check("b", "read");
      await assertRejects(() => access.check("a", "read"));
      await assertRejects(() => access.check("c", "read"));
    }));
});

Deno.test("runWithVaultAccess: an inner scope cannot replace the outer policy", async () => {
  const outerPolicy = policyAllowing("bot:outer", { erp: ["read"] });
  const innerPolicy = policyAllowing("bot:inner", {
    erp: ["read"],
    payroll: ["read"],
  });
  await runWithVaultAccess(
    RunVaultAccess.create({ policy: outerPolicy }),
    () =>
      runWithVaultAccess(
        RunVaultAccess.create({ policy: innerPolicy }),
        async () => {
          const access = currentVaultAccess()!;
          // The inner policy allows payroll; the inherited outer one refuses.
          const error = await assertRejects(
            () => access.check("payroll", "read"),
            VaultAccessDeniedError,
          );
          assertStringIncludes(error.message, "bot:outer");
          await access.check("erp", "read");
          assertEquals(innerPolicy.calls.includes("erp:read"), true);
        },
      ),
  );
});

Deno.test("runWithVaultAccess: an inner scope without a policy inherits the outer one", async () => {
  const outerPolicy = policyAllowing("bot:outer", { erp: ["read"] });
  await runWithVaultAccess(
    RunVaultAccess.create({ policy: outerPolicy }),
    () =>
      runWithVaultAccess(
        RunVaultAccess.create({ allowedVaults: ["erp", "payroll"] }),
        async () => {
          await assertRejects(() =>
            currentVaultAccess()!.check("payroll", "read")
          );
          await currentVaultAccess()!.check("erp", "read");
        },
      ),
  );
});

Deno.test("runWithVaultAccess: concurrent scopes stay isolated", async () => {
  const seen = await Promise.all(
    ["a", "b", "c"].map((name) =>
      runWithVaultAccess(
        RunVaultAccess.create({ allowedVaults: [name] }),
        async () => {
          await Promise.resolve();
          await new Promise<void>((resolve) => queueMicrotask(resolve));
          return [...currentVaultAccess()!.allowedVaults!];
        },
      )
    ),
  );
  assertEquals(seen, [["a"], ["b"], ["c"]]);
  assertEquals(currentVaultAccess(), undefined);
});

Deno.test("withoutVaultAccess: leaves the scope for control-plane work", async () => {
  await runWithVaultAccess(
    RunVaultAccess.create({ allowedVaults: [] }),
    async () => {
      assert(currentVaultAccess() !== undefined);
      await withoutVaultAccess(async () => {
        await Promise.resolve();
        assertEquals(currentVaultAccess(), undefined);
      });
      assert(currentVaultAccess() !== undefined);
    },
  );
});

Deno.test("runGeneratorWithVaultAccess: every next() runs in the scope, the consumer does not", async () => {
  async function* inner(): AsyncGenerator<string[] | undefined> {
    yield currentVaultAccess() && [...currentVaultAccess()!.allowedVaults!];
    await Promise.resolve();
    yield currentVaultAccess() && [...currentVaultAccess()!.allowedVaults!];
  }
  const seen: (string[] | undefined)[] = [];
  for await (
    const value of runGeneratorWithVaultAccess(
      RunVaultAccess.create({ allowedVaults: ["a"] }),
      inner,
    )
  ) {
    seen.push(value);
    assertEquals(currentVaultAccess(), undefined);
  }
  assertEquals(seen, [["a"], ["a"]]);
});

Deno.test("runGeneratorWithVaultAccess: narrows the scope the stream starts in", async () => {
  async function* inner(): AsyncGenerator<string[]> {
    yield [...currentVaultAccess()!.allowedVaults!];
  }
  const values = await runWithVaultAccess(
    RunVaultAccess.create({ allowedVaults: ["a", "b"] }),
    async () => {
      const out: string[][] = [];
      for await (
        const v of runGeneratorWithVaultAccess(
          RunVaultAccess.create({ allowedVaults: ["b", "c"] }),
          inner,
        )
      ) out.push(v);
      return out;
    },
  );
  assertEquals(values, [["b"]]);
});

Deno.test("runGeneratorWithVaultAccess: no access and no scope delegates unchanged", async () => {
  async function* inner(): AsyncGenerator<number, string> {
    yield 1;
    return "done";
  }
  const gen = runGeneratorWithVaultAccess(undefined, inner);
  assertEquals(await gen.next(), { value: 1, done: false });
  assertEquals(await gen.next(), { value: "done", done: true });
});

Deno.test("runGeneratorWithVaultAccess: forwards return() inside the scope", async () => {
  let finalScope: unknown = "unset";
  async function* inner(): AsyncGenerator<number> {
    try {
      yield 1;
      yield 2;
    } finally {
      finalScope = currentVaultAccess()?.allowedVaults;
    }
  }
  const gen = runGeneratorWithVaultAccess(
    RunVaultAccess.create({ allowedVaults: ["a"] }),
    inner,
  );
  await gen.next();
  await gen.return(undefined);
  assertInstanceOf(finalScope, Set);
  assertEquals([...(finalScope as Set<string>)], ["a"]);
});

/** A policy refusing `vault`, undetermined when the key is not known. */
function keyConditionedPolicy(
  vault: string,
): VaultPrincipalPolicy & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    principal: "user:bot",
    calls,
    decide(vaultName, action, secretKey, options) {
      calls.push([vaultName, action, secretKey, options?.keyUnknown]);
      if (vaultName !== vault) return { allowed: true, reason: "granted" };
      return options?.keyUnknown
        ? { allowed: false, undetermined: true, reason: "key condition" }
        : { allowed: false, reason: "denied by grant g-key" };
    },
  };
}

Deno.test("RunVaultAccess.check: with keyUnknown an outcome that depends on the key is not refused or reported", async () => {
  const denials: VaultAccessDenial[] = [];
  const policy = keyConditionedPolicy("outputs");
  const access = RunVaultAccess.create({
    policy,
    onDenied: (d) => {
      denials.push(d);
    },
  });
  await access.check("outputs", "write", undefined, { keyUnknown: true });
  assertEquals(
    await access.decide("outputs", "write", undefined, { keyUnknown: true }),
    { allowed: false, undetermined: true },
  );
  assertEquals(denials, []);
  assertEquals(policy.calls[0], ["outputs", "write", undefined, true]);
  // Once the key is known, the policy decides and refuses.
  await assertRejects(
    () => access.check("outputs", "write", "k"),
    VaultAccessDeniedError,
    "denied by grant g-key",
  );
  assertEquals(denials.length, 1);
});

Deno.test("RunVaultAccess.check: an undetermined decision without keyUnknown refuses", async () => {
  const access = RunVaultAccess.create({
    policy: {
      principal: "user:bot",
      decide: () => ({
        allowed: false,
        undetermined: true,
        reason: "key condition",
      }),
    },
  });
  await assertRejects(
    () => access.check("outputs", "write"),
    VaultAccessDeniedError,
  );
});

Deno.test("RunVaultAccess.check: with keyUnknown a workflow list and another policy still refuse", async () => {
  const listed = RunVaultAccess.create({
    policy: keyConditionedPolicy("outputs"),
    allowedVaults: ["erp"],
    allowListSource: "wf",
  });
  const error = await assertRejects(
    () => listed.check("outputs", "write", undefined, { keyUnknown: true }),
    VaultAccessDeniedError,
  );
  assertEquals(error.denial.workflow, "wf");

  const nested = RunVaultAccess.create({
    policy: keyConditionedPolicy("outputs"),
  }).narrowedBy(RunVaultAccess.create({
    policy: policyAllowing("user:other", {}),
  }));
  const refused = await assertRejects(
    () => nested.check("outputs", "write", undefined, { keyUnknown: true }),
    VaultAccessDeniedError,
  );
  assertEquals(refused.denial.principal, "user:other");
});
