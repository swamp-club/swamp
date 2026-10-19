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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import fc from "fast-check";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import {
  rehydratePersistedForm,
  toPersistedForm,
  type WrittenReference,
} from "./persisted_sensitive_form.ts";
import {
  RunSensitiveValues,
  vaultReferenceText,
} from "./run_sensitive_values.ts";

const source = { vaultName: "prod", key: "db-password" };
const secret = "Pl41nT3xt-S3cr3t";
const ref = vaultReferenceText(source);
const everywhere = () => true;

function recorded(): RunSensitiveValues {
  const values = new RunSensitiveValues();
  values.addSecret(secret, source);
  return values;
}

const read = (vault: string, key: string) =>
  Promise.resolve(vault === "prod" && key === "db-password" ? secret : "?");

Deno.test("toPersistedForm: replaces whole, embedded and sentinel values with references", () => {
  const values = recorded();
  const bag = new VaultSecretBag(values.sentinels);
  const sentinel = bag.addDataSecret(secret, source);
  const form = toPersistedForm(
    {
      whole: secret,
      embedded: `Bearer ${secret}`,
      spliced: `echo ${sentinel}`,
    },
    values,
    { applies: everywhere },
  );
  assertEquals(form.data, {
    whole: ref,
    embedded: `Bearer ${ref}`,
    spliced: `echo ${ref}`,
  });
  assertEquals(form.writtenReferences.length, 3);
  assertEquals(
    form.writtenReferences.find((r) => r.path[0] === "spliced")?.dataOrigin,
    true,
  );
});

Deno.test("toPersistedForm: leaves positions it does not apply to untouched", () => {
  const form = toPersistedForm(
    { id: "8080", inputs: { port: 8080, flag: true } },
    (() => {
      const values = new RunSensitiveValues();
      values.addSecret("8080", { vaultName: "v", key: "port" });
      values.addSecret("true", { vaultName: "v", key: "flag" });
      return values;
    })(),
    { applies: (path) => path[0] === "inputs" },
  );
  assertEquals((form.data as { id: string }).id, "8080");
  assertEquals(form.writtenReferences.map((r) => r.encoding), [
    "number",
    "boolean",
  ]);
});

Deno.test("toPersistedForm: JSON-escaped secrets are written and restored escaped", async () => {
  const pem = 'line1\n"quoted"';
  const values = new RunSensitiveValues();
  values.addSecret(pem, { vaultName: "prod", key: "tls" });
  const json = JSON.stringify({ key: pem });
  const form = toPersistedForm({ body: json }, values, { applies: everywhere });
  assertEquals(form.data.body.includes("line1"), false);
  const restored = await rehydratePersistedForm(
    form.data,
    form.writtenReferences,
    () => Promise.resolve(pem),
    new RunSensitiveValues(),
  );
  assertEquals(JSON.parse(restored.raw.body).key, pem);
});

Deno.test("rehydratePersistedForm: look-alike reference text in data stays inert", async () => {
  const values = recorded();
  const form = toPersistedForm(
    { mine: secret, theirs: ref, both: `${ref} ${secret}` },
    values,
    { applies: (path) => path[0] !== "theirs" },
  );
  const reads: string[] = [];
  const restored = await rehydratePersistedForm(
    form.data,
    form.writtenReferences,
    (vault, key) => {
      reads.push(`${vault}/${key}`);
      return read(vault, key);
    },
    new RunSensitiveValues(),
  );
  assertEquals(restored.raw, {
    mine: secret,
    theirs: ref,
    both: `${ref} ${secret}`,
  });
  assertEquals(reads.length, 2);
});

Deno.test("rehydratePersistedForm: sanitized copy carries data-origin sentinels and records values", async () => {
  const form = toPersistedForm({ run: `echo ${secret}` }, recorded(), {
    applies: everywhere,
  });
  const values = new RunSensitiveValues();
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const restored = await rehydratePersistedForm(
    form.data,
    form.writtenReferences,
    read,
    values,
    bag,
  );
  assertEquals(restored.raw.run, `echo ${secret}`);
  assertEquals(restored.sanitized.run.includes(secret), false);
  assertEquals(bag.resolveDeep(restored.sanitized), restored.raw);
  assertEquals(values.list(), [{ value: secret, source }]);
});

Deno.test("rehydratePersistedForm: refuses the reserved token vault", async () => {
  const entry: WrittenReference = {
    path: ["x"],
    occurrence: 0,
    vaultName: "_token-secrets",
    key: "k",
    encoding: "raw",
    dataOrigin: false,
  };
  await assertRejects(() =>
    rehydratePersistedForm(
      { x: vaultReferenceText(entry) },
      [entry],
      read,
      new RunSensitiveValues(),
    )
  );
});

Deno.test("toPersistedForm: rehydration round-trips any structure", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.string({ minLength: 3, maxLength: 10 }), {
        minLength: 1,
        maxLength: 3,
      }),
      fc.jsonValue(),
      async (secrets, noise) => {
        const values = new RunSensitiveValues();
        const byKey = new Map<string, string>();
        secrets.forEach((value, i) => {
          if (values.sourceOf(value)) return;
          values.addSecret(value, { vaultName: "v", key: `k${i}` });
          byKey.set(`k${i}`, value);
        });
        const data = {
          noise,
          text: `a${secrets.join("|")}b${
            vaultReferenceText({ vaultName: "v", key: "k0" })
          }`,
          whole: secrets[0],
        };
        const form = toPersistedForm(data, values, { applies: everywhere });
        const restored = await rehydratePersistedForm(
          form.data,
          form.writtenReferences,
          (_vault, key) => Promise.resolve(byKey.get(key) ?? ""),
          new RunSensitiveValues(),
        );
        assertEquals(JSON.stringify(restored.raw), JSON.stringify(data));
      },
    ),
  );
});

Deno.test("rehydratePersistedForm: a coerced value whose vault value was rotated fails clearly", async () => {
  const values = new RunSensitiveValues();
  values.addSecret("8080", { vaultName: "prod", key: "port" });
  const form = toPersistedForm({ port: 8080 }, values, { applies: everywhere });
  await assertRejects(
    () =>
      rehydratePersistedForm(
        form.data,
        form.writtenReferences,
        () => Promise.resolve("not-a-number"),
        new RunSensitiveValues(),
      ),
    Error,
    "no longer a number",
  );
  const restored = await rehydratePersistedForm(
    form.data,
    form.writtenReferences,
    () => Promise.resolve("8080"),
    new RunSensitiveValues(),
  );
  assertEquals(restored.raw, { port: 8080 });
});

Deno.test("rehydratePersistedForm: sentinels only where a fresh run sanitizes, real values elsewhere", async () => {
  const values = recorded();
  const form = toPersistedForm(
    { args: { run: `echo ${secret}` }, description: `for ${secret}` },
    values,
    { applies: everywhere },
  );
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const restored = await rehydratePersistedForm(
    form.data,
    form.writtenReferences,
    read,
    new RunSensitiveValues(),
    bag,
    (path) => path[0] === "args",
  );
  assertEquals(restored.sanitized.description, `for ${secret}`);
  assertEquals(restored.sanitized.args.run.includes(secret), false);
  assertEquals(bag.resolveRaw(restored.sanitized.args.run), `echo ${secret}`);
});

Deno.test("toPersistedForm: a vault.get sentinel is written as its reference from its entry, with no recorded value", () => {
  const values = new RunSensitiveValues();
  const bag = new VaultSecretBag(values.sentinels);
  const sentinel = bag.addSecret({ vaultName: "prod", key: "k" }, "run");
  const form = toPersistedForm({ run: `echo ${sentinel}` }, values, {
    applies: () => false,
  });
  assertEquals(form.data, {
    run: `echo ${vaultReferenceText({ vaultName: "prod", key: "k" })}`,
  });
  assertEquals(form.writtenReferences, [{
    path: ["run"],
    occurrence: 0,
    vaultName: "prod",
    key: "k",
    encoding: "raw",
    dataOrigin: false,
  }]);
});

Deno.test("toPersistedForm: a JSON-encoded data sentinel keeps its encoding from its entry", () => {
  const values = recorded();
  const bag = new VaultSecretBag(values.sentinels);
  const escaped = JSON.stringify('a"b').slice(1, -1);
  const sentinel = bag.addDataSecret(escaped, source, "json");
  const form = toPersistedForm({ body: `{"k":"${sentinel}"}` }, values, {
    applies: () => false,
  });
  assertEquals(form.writtenReferences.map((r) => [r.encoding, r.dataOrigin]), [
    ["json", true],
  ]);
});

Deno.test("toPersistedForm: a sentinel with a prefix of this run but no entry fails the write", () => {
  const values = new RunSensitiveValues();
  const bag = new VaultSecretBag(values.sentinels);
  const issued = bag.addSecret(source, "run");
  const unknown = issued.replace(/_\d+__$/, "_999__");
  assertThrows(
    () => toPersistedForm({ run: unknown }, values, { applies: everywhere }),
    Error,
    "has no entry",
  );
});

Deno.test("toPersistedForm: sentinel-shaped text with another prefix is written as data", () => {
  const values = recorded();
  new VaultSecretBag(values.sentinels).addSecret(source, "run");
  const foreign = `__SWAMP_VSEC_${"f".repeat(32)}_0__`;
  const form = toPersistedForm(
    { run: `${foreign} ${secret}` },
    values,
    { applies: everywhere },
  );
  assertEquals(form.data.run, `${foreign} ${ref}`);
  assertEquals(form.writtenReferences.length, 1);
});

Deno.test("rehydratePersistedForm: an issued sentinel carries the written entry's reference and encoding", async () => {
  const values = new RunSensitiveValues();
  const bag = new VaultSecretBag(values.sentinels);
  const restored = await rehydratePersistedForm(
    { run: `echo ${ref}`, body: `{"k":"${ref}"}` },
    [
      {
        path: ["run"],
        occurrence: 0,
        vaultName: source.vaultName,
        key: source.key,
        encoding: "raw",
        dataOrigin: true,
      },
      {
        path: ["body"],
        occurrence: 0,
        vaultName: source.vaultName,
        key: source.key,
        encoding: "json",
        dataOrigin: false,
      },
    ],
    () => Promise.resolve('p"w'),
    values,
    bag,
  );
  const [runSentinel] = restored.sanitized.run.match(
    VaultSecretBag.SENTINEL_PATTERN,
  )!;
  const [bodySentinel] = restored.sanitized.body.match(
    VaultSecretBag.SENTINEL_PATTERN,
  )!;
  assertEquals(values.sentinels.issuedEntryOf(runSentinel), {
    sentinel: runSentinel,
    value: 'p"w',
    reference: source,
    encoding: "raw",
    dataOrigin: true,
  });
  assertEquals(values.sentinels.issuedEntryOf(bodySentinel)?.encoding, "json");
  const bodyEntry = values.sentinels.issuedEntryOf(bodySentinel);
  assertEquals(bodyEntry?.dataOrigin && bodyEntry.value, 'p\\"w');
  assertEquals(JSON.parse(bag.resolveRaw(restored.sanitized.body)).k, 'p"w');
});
