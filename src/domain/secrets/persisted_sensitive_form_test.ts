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

import { assertEquals, assertRejects } from "@std/assert";
import fc from "fast-check";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
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
  const bag = new VaultSecretBag();
  const sentinel = bag.addDataSecret(secret);
  const form = toPersistedForm(
    {
      whole: secret,
      embedded: `Bearer ${secret}`,
      spliced: `echo ${sentinel}`,
    },
    values,
    { bag, applies: everywhere },
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
  const bag = new VaultSecretBag();
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
  const bag = new VaultSecretBag();
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
