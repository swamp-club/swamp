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
import { z } from "zod";
import { computeChecksum } from "../domain/models/checksum.ts";
import {
  RECORD_KIND_TAG,
  SENSITIVE_FIELDS_TAG,
  SENSITIVE_FIELDS_VERSION,
  SENSITIVE_FIELDS_VERSION_TAG,
} from "../domain/models/data_writer.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { UnifiedDataRepository } from "../domain/data/repositories.ts";
import type { ActiveDispatch } from "./dispatch_registry.ts";
import {
  assertSecretKeyNotDenied,
  assertVaultNotDenied,
  ResourceClaimRefusedError,
  ResourceClaimVerifier,
} from "./dispatch_secret_authorization.ts";

const MODEL_TYPE = ModelType.create("acme/claims");

interface Stored {
  name: string;
  version: number;
  tags: Record<string, string>;
  content: unknown;
  ownerRef?: string;
}

function repoHolding(record: Stored): {
  repo: UnifiedDataRepository;
  reads: { count: number };
} {
  const bytes = new TextEncoder().encode(JSON.stringify(record.content));
  const reads = { count: 0 };
  const repo = {
    findByName: async (
      _type: ModelType,
      modelId: string,
      name: string,
      version?: number,
    ) => {
      reads.count++;
      if (name !== record.name || version !== record.version) return null;
      return {
        name,
        version,
        tags: record.tags,
        checksum: await computeChecksum(bytes),
        ownerDefinition: {
          ownerType: "model-method",
          ownerRef: record.ownerRef ?? modelId,
        },
      };
    },
    getContent: () => Promise.resolve(bytes),
  } as unknown as UnifiedDataRepository;
  return { repo, reads };
}

function dispatchWithSpec(): ActiveDispatch {
  return {
    workerName: "worker-1",
    dispatchId: crypto.randomUUID(),
    leaseId: "lease-1",
    modelDef: {
      resources: {
        state: {
          schema: z.object({
            password: z.string().meta({ sensitive: true }),
            note: z.string(),
          }),
        },
      },
    } as never,
    modelType: MODEL_TYPE,
    modelId: "model-1",
    methodName: "run",
    definitionName: "claims",
    definitionTags: {},
  };
}

const CONTENT = {
  password: "${{ vault.get('default', 'password-key') }}",
  note: "${{ vault.get('default', 'note-key') }}",
};

/** A legacy record: written before the writers stamped `_swamp.kind`. */
const LEGACY_UNTAGGED: Stored = {
  name: "state-main",
  version: 1,
  tags: { type: "resource", specName: "state" },
  content: CONTENT,
};

const TAGGED: Stored = {
  name: "state-main",
  version: 2,
  tags: {
    type: "resource",
    specName: "state",
    [RECORD_KIND_TAG]: "resource",
    [SENSITIVE_FIELDS_TAG]: JSON.stringify(["password"]),
    [SENSITIVE_FIELDS_VERSION_TAG]: SENSITIVE_FIELDS_VERSION,
  },
  content: CONTENT,
};

function verifier(
  repo: UnifiedDataRepository,
  schemaFallback: boolean,
): ResourceClaimVerifier {
  return new ResourceClaimVerifier({
    verb: "test",
    repoFor: () => repo,
    schemaFallback,
  });
}

async function refusalReason(promise: Promise<void>): Promise<string> {
  const error = await assertRejects(() => promise, ResourceClaimRefusedError);
  return (error as ResourceClaimRefusedError).reason;
}

Deno.test("assertVaultNotDenied: refuses the reserved token vault and admits others", () => {
  assertThrows(() => assertVaultNotDenied("_token-secrets", "test"), Error);
  assertVaultNotDenied("default", "test");
});

Deno.test("assertSecretKeyNotDenied: refuses infrastructure keys in any case", () => {
  for (
    const key of ["server-token-x", "WORKER-TOKEN-y", "oauth-client-secret"]
  ) {
    assertThrows(() => assertSecretKeyNotDenied(key, "test"), Error);
  }
  assertSecretKeyNotDenied("db-password", "test");
});

Deno.test("ResourceClaimVerifier: a tagged field is admitted in both modes, an untagged field of it in neither", async () => {
  for (const schemaFallback of [false, true]) {
    const { repo } = repoHolding(TAGGED);
    const claims = verifier(repo, schemaFallback);
    const dispatch = dispatchWithSpec();
    const claim = { name: TAGGED.name, version: TAGGED.version };
    await claims.verify(dispatch, claim, "default", "password-key");
    assertEquals(
      await refusalReason(
        claims.verify(dispatch, claim, "default", "note-key"),
      ),
      "its sensitive fields do not reference it",
    );
  }
});

Deno.test("ResourceClaimVerifier: a legacy untagged record is admitted by serve's spec only with the schema fallback (swamp-club#3530)", async () => {
  const claim = {
    name: LEGACY_UNTAGGED.name,
    version: LEGACY_UNTAGGED.version,
  };
  const { repo } = repoHolding(LEGACY_UNTAGGED);

  assertEquals(
    await refusalReason(
      verifier(repo, false).verify(
        dispatchWithSpec(),
        claim,
        "default",
        "password-key",
      ),
    ),
    "the record has no sensitive fields",
  );

  const claims = verifier(repo, true);
  const dispatch = dispatchWithSpec();
  await claims.verify(dispatch, claim, "default", "password-key");
  // The spec marks only the password sensitive.
  assertEquals(
    await refusalReason(claims.verify(dispatch, claim, "default", "note-key")),
    "its sensitive fields do not reference it",
  );
});

Deno.test("ResourceClaimVerifier: the schema fallback skips a record a current writer stamped", async () => {
  const stamped: Stored = {
    ...LEGACY_UNTAGGED,
    tags: { ...LEGACY_UNTAGGED.tags, [RECORD_KIND_TAG]: "resource" },
  };
  const { repo } = repoHolding(stamped);
  assertEquals(
    await refusalReason(
      verifier(repo, true).verify(
        dispatchWithSpec(),
        { name: stamped.name, version: stamped.version },
        "default",
        "password-key",
      ),
    ),
    "the record has no sensitive fields",
  );
});

Deno.test("ResourceClaimVerifier: the schema fallback reads serve's spec, so a dispatch without one admits nothing", async () => {
  const { repo } = repoHolding(LEGACY_UNTAGGED);
  const dispatch = { ...dispatchWithSpec(), modelDef: {} as never };
  assertEquals(
    await refusalReason(
      verifier(repo, true).verify(
        dispatch,
        { name: LEGACY_UNTAGGED.name, version: LEGACY_UNTAGGED.version },
        "default",
        "password-key",
      ),
    ),
    "the record has no sensitive fields",
  );
});

Deno.test("ResourceClaimVerifier: a tagged record without the writer-version tag is refused in both modes", async () => {
  const unversioned: Stored = {
    ...TAGGED,
    tags: { ...TAGGED.tags, [SENSITIVE_FIELDS_VERSION_TAG]: "0" },
  };
  for (const schemaFallback of [false, true]) {
    const { repo } = repoHolding(unversioned);
    assertEquals(
      await refusalReason(
        verifier(repo, schemaFallback).verify(
          dispatchWithSpec(),
          { name: unversioned.name, version: unversioned.version },
          "default",
          "password-key",
        ),
      ),
      "the record predates verified sensitive-field writes",
    );
  }
});

Deno.test("ResourceClaimVerifier: a record of another owner is refused in both modes", async () => {
  for (const schemaFallback of [false, true]) {
    const { repo } = repoHolding({ ...LEGACY_UNTAGGED, ownerRef: "other" });
    assertEquals(
      await refusalReason(
        verifier(repo, schemaFallback).verify(
          dispatchWithSpec(),
          { name: LEGACY_UNTAGGED.name, version: LEGACY_UNTAGGED.version },
          "default",
          "password-key",
        ),
      ),
      "the record identity does not match the dispatched behavior",
    );
  }
});

Deno.test("ResourceClaimVerifier: a verified claim reads its record once per dispatch", async () => {
  const { repo, reads } = repoHolding(TAGGED);
  const claims = verifier(repo, true);
  const claim = { name: TAGGED.name, version: TAGGED.version };
  const dispatch = dispatchWithSpec();
  await claims.verify(dispatch, claim, "default", "password-key");
  await claims.verify(dispatch, claim, "default", "password-key");
  assertEquals(reads.count, 1);
  await claims.verify(dispatchWithSpec(), claim, "default", "password-key");
  assertEquals(reads.count, 2);
});
