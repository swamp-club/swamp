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

import { assert } from "@std/assert";
import fc from "fast-check";
import { z } from "zod";
import { createResourceWriter } from "./data_writer.ts";
import { ModelType } from "./model_type.ts";
import type { ResourceOutputSpec } from "./model.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import { SOLO_NAMESPACE } from "../data/namespace.ts";
import { generateDataId } from "../data/data_id.ts";
import { VaultService } from "../vaults/vault_service.ts";
import { SecretRedactor } from "../secrets/secret_redactor.ts";

const modelType = ModelType.create("swamp/test");
const modelId = "test-model-id";

/** Secrets for the instance name, kept to characters a data name accepts. */
const arbNameSecret = fc.stringMatching(/^[A-Z]{3,8}$/);

/**
 * Secrets for the payload, including the characters JSON escapes or uses as
 * structure, and two-character escape sequences such as a one-line key's
 * literal backslash-n.
 */
const arbSecret = fc.stringMatching(/^(?:[A-Z"{}:,\n]|\\n){3,8}$/);

/**
 * A secret that is itself JSON, as a vault value a method parses and writes
 * back as structure: an array or an object of uppercase strings.
 */
const arbJsonSecret = fc.oneof(
  fc.array(fc.stringMatching(/^[A-Z]{1,4}$/), { minLength: 1, maxLength: 3 }),
  fc.dictionary(
    fc.stringMatching(/^[a-z]{1,3}$/),
    fc.stringMatching(/^[A-Z]{1,4}$/),
    { minKeys: 1, maxKeys: 3 },
  ),
);

const spec: ResourceOutputSpec = {
  schema: z.object({
    token: z.string().meta({ sensitive: true }),
    creds: z.object({ key: z.string().meta({ sensitive: true }) }),
  }),
  lifetime: "infinite",
  garbageCollection: 5,
};

function createCapturingRepo(): UnifiedDataRepository & {
  persisted: () => string;
} {
  let content: Uint8Array | null = null;
  const save: UnifiedDataRepository["save"] = (_type, _id, _data, saved) => {
    content = saved;
    return Promise.resolve({ version: 1 });
  };
  return {
    namespace: SOLO_NAMESPACE,
    save,
    findByName: () => Promise.resolve(null),
    nextId: () => generateDataId(),
    persisted: () => new TextDecoder().decode(content ?? new Uint8Array()),
  } as unknown as UnifiedDataRepository & { persisted: () => string };
}

Deno.test("createResourceWriter: persisted content keeps vault references exact and leaks no registered secret outside them", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        nameSecret: arbNameSecret,
        secrets: fc.uniqueArray(arbSecret, { minLength: 1, maxLength: 3 }),
        jsonSecret: arbJsonSecret,
        extra: fc.jsonValue(),
      }).chain((drawn) =>
        fc.record({
          drawn: fc.constant(drawn),
          note: fc.array(
            fc.oneof(
              fc.constantFrom(drawn.nameSecret, ...drawn.secrets),
              fc.stringMatching(/^[a-z ]{0,4}$/),
            ),
          ).map((parts) => parts.join("")),
        })
      ),
      async ({ drawn: { nameSecret, secrets, jsonSecret, extra }, note }) => {
        const repo = createCapturingRepo();
        const vaultService = new VaultService();
        vaultService.registerVault({
          name: "test-vault",
          type: "mock",
          config: {},
        });
        const redactor = new SecretRedactor();
        redactor.addSecret(nameSecret);
        for (const secret of secrets) redactor.addSecret(secret);
        redactor.addSecret(JSON.stringify(jsonSecret));
        const { writeResource } = createResourceWriter(
          repo,
          modelType,
          modelId,
          { r: spec },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          vaultService,
          "put",
          undefined,
          redactor,
        );
        const data: Record<string, unknown> = {
          token: "token-value",
          creds: { key: "key-value" },
          note,
          extra,
          structured: { inner: jsonSecret, beside: note },
          // A secret's escape sequences written back as the characters.
          unescaped: secrets.map((s) => s.replaceAll("\\n", "\n")),
        };

        await writeResource("r", `n~${nameSecret}~1`, data);

        const text = repo.persisted();
        const references = [
          JSON.stringify(data.token),
          JSON.stringify((data.creds as Record<string, unknown>).key),
        ];
        for (const reference of references) {
          assert(text.includes(reference), `${reference} missing`);
        }
        // Between the references, no registered secret survives.
        let pieces = [text];
        for (const reference of references) {
          pieces = pieces.flatMap((piece) => piece.split(reference));
        }
        for (const piece of pieces) {
          assert(redactor.redact(piece) === piece, `secret left in ${piece}`);
        }
      },
    ),
  );
});
