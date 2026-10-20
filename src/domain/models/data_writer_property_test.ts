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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { z } from "zod";
import {
  createResourceWriter,
  getSensitiveFieldsForResolution,
  parseSensitiveFieldsTag,
  resolveSensitiveVaultRefs,
  SENSITIVE_FIELDS_TAG,
  SENSITIVE_FIELDS_VERSION,
  SENSITIVE_FIELDS_VERSION_TAG,
  sensitiveVaultReferences,
} from "./data_writer.ts";
import { ResourceSensitiveFieldsInvalidError } from "../vaults/secret_reference_errors.ts";
import { isReservedTagKey } from "../data/data.ts";
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

/** Tag keys a user might write: ordinary ones, and keys under `_swamp.`. */
const arbTagKey = fc.oneof(
  fc.string({ minLength: 1, maxLength: 12 }),
  fc.string({ maxLength: 12 }).map((rest) => `_swamp.${rest}`),
  fc.constant(SENSITIVE_FIELDS_TAG),
);
const arbTags = fc.option(
  fc.dictionary(arbTagKey, fc.string({ maxLength: 8 }), { maxKeys: 3 }),
  { nil: undefined },
);

function hasReservedKey(tags: Record<string, string> | undefined): boolean {
  return Object.keys(tags ?? {}).some(isReservedTagKey);
}

Deno.test("createResourceWriter: a user-supplied reserved tag is always refused, and only the writer's own reaches a record", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        definitionTags: arbTags,
        specTags: arbTags,
        overrideTags: arbTags,
        tagOverrides: arbTags,
        runtimeTags: arbTags,
        dataOutputTags: arbTags,
        sensitive: fc.boolean(),
      }),
      async (drawn) => {
        const vaultService = new VaultService();
        vaultService.registerVault({
          name: "test-vault",
          type: "mock",
          config: {},
        });
        const resourceSpec: ResourceOutputSpec = {
          schema: drawn.sensitive
            ? z.object({ value: z.string().meta({ sensitive: true }) })
            : z.object({ value: z.string() }),
          lifetime: "infinite",
          garbageCollection: 5,
          ...(drawn.specTags ? { tags: drawn.specTags } : {}),
        };
        const { writeResource } = createResourceWriter(
          createCapturingRepo(),
          modelType,
          modelId,
          { r: resourceSpec },
          drawn.tagOverrides,
          drawn.dataOutputTags
            ? [{ specName: "r", tags: drawn.dataOutputTags }]
            : undefined,
          drawn.definitionTags,
          drawn.runtimeTags,
          undefined,
          vaultService,
          "put",
        );
        const forged = [
          drawn.definitionTags,
          drawn.specTags,
          drawn.overrideTags,
          drawn.tagOverrides,
          drawn.runtimeTags,
          drawn.dataOutputTags,
        ].some(hasReservedKey);

        let tags: Record<string, string> | undefined;
        try {
          const handle = await writeResource(
            "r",
            "main",
            { value: "v" },
            drawn.overrideTags ? { tags: drawn.overrideTags } : undefined,
          );
          tags = handle.tags;
        } catch (error) {
          assert(forged, `refused without a reserved tag: ${error}`);
          assert(String(error).includes("is reserved"), String(error));
          return;
        }
        assert(!forged, "a reserved tag was accepted");
        const reserved = Object.keys(tags).filter(isReservedTagKey);
        assertEquals(
          reserved,
          drawn.sensitive
            ? [SENSITIVE_FIELDS_TAG, SENSITIVE_FIELDS_VERSION_TAG]
            : [],
        );
        assertEquals(
          tags[SENSITIVE_FIELDS_VERSION_TAG],
          drawn.sensitive ? SENSITIVE_FIELDS_VERSION : undefined,
        );
      },
    ),
  );
});

/** Dot-paths as the vaulting step writes them into the tag. */
const arbFieldPaths = fc.array(
  fc.stringMatching(/^[a-z]{1,6}(?:\.[a-z]{1,6}){0,2}$/),
  { maxLength: 4 },
);

Deno.test("sensitive-fields tag: a JSON array of paths round-trips through both parses, and the strict reading refuses every tag the lenient parse reads as absent", () => {
  const specs = { creds: spec };

  fc.assert(
    fc.property(arbFieldPaths, (paths) => {
      const tags = {
        specName: "creds",
        [SENSITIVE_FIELDS_TAG]: JSON.stringify(paths),
      };
      assertEquals(parseSensitiveFieldsTag(tags), paths);
      // A present tag wins: the schema's own paths are never consulted.
      assertEquals(
        getSensitiveFieldsForResolution(tags, specs, "inst"),
        paths,
      );
    }),
  );

  // For every tag text: a tag the lenient parse reads as absent is one the
  // strict reading refuses, and whenever the strict reading accepts a tag it
  // returns what the lenient parse does. The strict reading also refuses
  // tags the lenient parse accepts (an empty or unsafe path segment).
  fc.assert(
    fc.property(fc.string(), (raw) => {
      const tags = { specName: "creds", [SENSITIVE_FIELDS_TAG]: raw };
      const lenient = parseSensitiveFieldsTag(tags);
      let strict: string[] | "*" | null | undefined;
      let refused = false;
      try {
        strict = getSensitiveFieldsForResolution(tags, specs, "inst");
      } catch (error) {
        assert(error instanceof ResourceSensitiveFieldsInvalidError, raw);
        refused = true;
      }
      if (lenient === null) {
        assert(refused, raw);
      } else if (!refused) {
        assertEquals(strict, lenient, raw);
      }
    }),
  );
});

/**
 * A record in the shape the writer leaves it: a string (a vault reference
 * or plain text) or null at every tagged location, and anything at all
 * elsewhere. Under the star tag every top-level key is a tagged location,
 * dotted keys included; with listed paths the tagged keys and the untagged
 * keys come from disjoint alphabets.
 */
const arbRefName = fc.stringMatching(/^[a-z0-9_-]{1,6}$/);
const arbReferenceText = fc.tuple(arbRefName, arbRefName).map(([v, k]) =>
  `\${{ vault.get('${v}', '${k}') }}`
);
const arbTaggedValue = fc.oneof(
  arbReferenceText,
  fc.stringMatching(/^[a-z ]{0,6}$/),
  fc.constant(null),
);
const arbLeaf = fc.oneof(
  arbTaggedValue,
  fc.integer(),
  fc.boolean(),
);
const arbUntaggedKey = fc.stringMatching(/^u[a-z]{0,2}$/);
const { node: arbNode } = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: "small" },
    arbLeaf,
    fc.array(tie("node"), { maxLength: 3 }),
    fc.dictionary(arbUntaggedKey, tie("node"), { maxKeys: 3 }),
  ),
}));
const arbWriterShaped = fc.oneof(
  fc.dictionary(fc.stringMatching(/^[a-z.]{1,4}$/), arbTaggedValue, {
    minKeys: 1,
    maxKeys: 4,
  }).map((record) => ({ record, sensitiveFields: "*" as const })),
  fc.tuple(
    fc.dictionary(fc.stringMatching(/^t[a-z]{0,2}$/), arbTaggedValue, {
      maxKeys: 3,
    }),
    fc.dictionary(arbUntaggedKey, arbNode, { maxKeys: 3 }),
  ).map(([tagged, untagged]) => ({
    record: { ...untagged, ...tagged },
    sensitiveFields: Object.keys(tagged),
  })),
);

Deno.test("sensitiveVaultReferences: for a record in the writer's shape, names exactly the references resolveSensitiveVaultRefs reads, in first-read order (swamp-club#3529)", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbWriterShaped,
      async ({ record, sensitiveFields }) => {
        const reads: string[] = [];
        const countingVault = {
          get: (vaultName: string, key: string) => {
            reads.push(`${vaultName}\u0000${key}`);
            return Promise.resolve("value");
          },
        } as unknown as VaultService;
        await resolveSensitiveVaultRefs(
          structuredClone(record),
          sensitiveFields,
          countingVault,
        );
        assertEquals(
          sensitiveVaultReferences(record, sensitiveFields).map((ref) =>
            `${ref.vaultName}\u0000${ref.key}`
          ),
          [...new Set(reads)],
        );
      },
    ),
    { numRuns: 300 },
  );
});
