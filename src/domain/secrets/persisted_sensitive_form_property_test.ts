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
import fc from "fast-check";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import {
  rehydrateReferences,
  toPersistedForm,
} from "./persisted_sensitive_form.ts";
import { RunSensitiveValues } from "./run_sensitive_values.ts";

/**
 * A secret to issue: its value, its reference, its origin and encoding. The
 * value's alphabet never occurs in reference text or JSON punctuation, so
 * its absence from the persisted form is checkable; quotes and backslashes
 * exercise the json encoding.
 */
const arbSecret = fc.record({
  value: fc.stringMatching(/^[A-Z"\\]{3,10}$/),
  key: fc.stringMatching(/^[a-z]{1,6}$/),
  dataOrigin: fc.boolean(),
  json: fc.boolean(),
});

Deno.test("toPersistedForm: every sentinel of the run persists as its entry's reference and rehydrates to its value, with no value search", () => {
  fc.assert(
    fc.property(
      fc.array(arbSecret, { minLength: 1, maxLength: 4 }),
      fc.jsonValue(),
      (secrets, noise) => {
        // Entries, never recorded values: the value search has nothing.
        const values = new RunSensitiveValues();
        const bag = new VaultSecretBag(values.sentinels);
        const vault = new Map<string, string>();
        // What a load at delivery reads for each vault.get sentinel.
        const loads = new Map<string, string>();
        const sentinels = secrets.map((secret, i) => {
          const key = `${secret.key}${i}`;
          const reference = { vaultName: "prod", key };
          vault.set(key, secret.value);
          if (!secret.dataOrigin) {
            const sentinel = bag.addSecret(reference, "data");
            loads.set(sentinel, secret.value);
            return sentinel;
          }
          const form = secret.json
            ? JSON.stringify(secret.value).slice(1, -1)
            : secret.value;
          return bag.addDataSecret(
            form,
            reference,
            secret.json ? "json" : "raw",
          );
        });
        const data = {
          noise,
          whole: sentinels[0],
          text: `a${sentinels.join("|")}b${sentinels[0]}`,
          list: sentinels.map((s) => `<${s}>`),
        };
        const form = toPersistedForm(data, values);

        // The fields that held sentinels hold references now: no sentinel
        // and no value. (`noise` is random JSON and may hold anything.)
        const persisted = JSON.stringify({
          whole: form.data.whole,
          text: form.data.text,
          list: form.data.list,
        });
        for (const sentinel of sentinels) {
          assertEquals(persisted.includes(sentinel), false);
        }
        for (const secret of secrets) {
          assertEquals(persisted.includes(JSON.stringify(secret.value)), false);
          assertEquals(persisted.includes(secret.value), false);
        }
        // Each occurrence of a sentinel yields its entry's reference: one in
        // `whole`, one per sentinel plus one more in `text`, one per sentinel
        // in `list`.
        assertEquals(form.writtenReferences.length, 2 * sentinels.length + 2);
        const byKey = new Map(
          sentinels.map((s) => {
            const entry = bag.registry.issuedEntryOf(s)!;
            return [entry.reference.key, entry];
          }),
        );
        for (const written of form.writtenReferences) {
          const issued = byKey.get(written.key);
          assertEquals(issued !== undefined, true);
          assertEquals(written.vaultName, "prod");
          assertEquals(written.encoding, issued!.encoding);
          assertEquals(written.dataOrigin, issued!.dataOrigin);
        }

        const reader = new RunSensitiveValues();
        const readerBag = new VaultSecretBag(reader.sentinels);
        const restored = rehydrateReferences(
          form.data,
          form.writtenReferences,
          readerBag,
          "replay",
        );
        assertEquals(toPersistedForm(restored, reader), form);
      },
    ),
  );
});

Deno.test("rehydrateReferences: a typed run restores any persisted form to sentinels that persist back identically, with no value and no read (typed-secrets 4.4)", () => {
  fc.assert(
    fc.property(
      fc.array(arbSecret, { minLength: 1, maxLength: 4 }),
      fc.jsonValue(),
      (secrets, noise) => {
        // Written by a fresh typed run from its sentinels.
        const writer = new RunSensitiveValues(
          undefined,
          new SecretBagRegistry(),
        );
        const writerBag = new VaultSecretBag(writer.sentinels);
        const sentinels = secrets.map((secret, i) =>
          secret.dataOrigin
            ? writerBag.addDataReference(
              { vaultName: "prod", key: `${secret.key}${i}` },
              "data",
            )
            : writerBag.addSecret(
              { vaultName: "prod", key: `${secret.key}${i}` },
              "data",
            )
        );
        const data = {
          noise,
          whole: sentinels[0],
          text: `a${sentinels.join("|")}b${sentinels[0]}`,
          list: sentinels.map((s) => `<${s}>`),
        };
        const form = toPersistedForm(data, writer);

        // Read back by another typed run: references again, in a new bag.
        const reader = new RunSensitiveValues(
          undefined,
          new SecretBagRegistry(),
        );
        const readerBag = new VaultSecretBag(reader.sentinels);
        const restored = rehydrateReferences(
          form.data,
          form.writtenReferences,
          readerBag,
          "wf",
        );
        assertEquals(reader.isEmpty, true);
        const again = toPersistedForm(restored, reader);
        assertEquals(JSON.stringify(again.data), JSON.stringify(form.data));
        assertEquals(
          again.writtenReferences.length,
          form.writtenReferences.length,
        );
        // Every restored sentinel carries the written entry's identity, and
        // none holds a value.
        for (const entry of readerBag.registry.all()) {
          assertEquals("value" in entry, false);
        }
        const restoredFields = JSON.stringify({
          whole: restored.whole,
          text: restored.text,
          list: restored.list,
        });
        for (const secret of secrets) {
          assertEquals(restoredFields.includes(secret.value), false);
        }
      },
    ),
  );
});

Deno.test("rehydrateReferences: every legacy reference retains the historical data origin across rewrite", () => {
  fc.assert(
    fc.property(
      fc.array(arbSecret, { minLength: 1, maxLength: 6 }),
      fc.integer({ min: 0, max: 2 }),
      (secrets, format) => {
        const writer = new RunSensitiveValues();
        const writerBag = new VaultSecretBag(writer.sentinels);
        const data = {
          items: secrets.map((secret, i) =>
            writerBag.addWrittenReference(
              { vaultName: "prod", key: `${secret.key}${i}` },
              secret.json ? "json" : "raw",
              secret.dataOrigin,
              "test",
            )
          ),
        };
        const persisted = toPersistedForm(data, writer);
        const reader = new RunSensitiveValues();
        const readerBag = new VaultSecretBag(reader.sentinels);
        const restored = rehydrateReferences(
          persisted.data,
          persisted.writtenReferences,
          readerBag,
          "legacy",
          format,
        );
        assertEquals(reader.isEmpty, true);
        assertEquals(toPersistedForm(restored, reader), {
          data: persisted.data,
          writtenReferences: persisted.writtenReferences.map((entry) => ({
            ...entry,
            dataOrigin: true,
          })),
        });
      },
    ),
  );
});
