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

function verifier(repo: UnifiedDataRepository): ResourceClaimVerifier {
  return new ResourceClaimVerifier({ verb: "test", repoFor: () => repo });
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

Deno.test("ResourceClaimVerifier: a tagged field is admitted, an untagged field of the same record is not", async () => {
  const { repo } = repoHolding(TAGGED);
  const claims = verifier(repo);
  const dispatch = dispatchWithSpec();
  const claim = { name: TAGGED.name, version: TAGGED.version };
  await claims.verify(dispatch, claim, "default", "password-key");
  assertEquals(
    await refusalReason(claims.verify(dispatch, claim, "default", "note-key")),
    "its sensitive fields do not reference it",
  );
});

Deno.test("ResourceClaimVerifier: a legacy untagged record is refused, even when the dispatch's spec marks the field sensitive", async () => {
  // Such a record predates the writer guards, so a reference in it may be
  // text nobody vaulted; the schema fallback waits for typed-secrets 5.2.
  const { repo } = repoHolding(LEGACY_UNTAGGED);
  assertEquals(
    await refusalReason(
      verifier(repo).verify(
        dispatchWithSpec(),
        { name: LEGACY_UNTAGGED.name, version: LEGACY_UNTAGGED.version },
        "default",
        "password-key",
      ),
    ),
    "the record has no sensitive fields",
  );
});

Deno.test("ResourceClaimVerifier: a tagged record without the writer-version tag is refused", async () => {
  const unversioned: Stored = {
    ...TAGGED,
    tags: { ...TAGGED.tags, [SENSITIVE_FIELDS_VERSION_TAG]: "0" },
  };
  const { repo } = repoHolding(unversioned);
  assertEquals(
    await refusalReason(
      verifier(repo).verify(
        dispatchWithSpec(),
        { name: unversioned.name, version: unversioned.version },
        "default",
        "password-key",
      ),
    ),
    "the record predates verified sensitive-field writes",
  );
});

Deno.test("ResourceClaimVerifier: a record of another owner is refused", async () => {
  const { repo } = repoHolding({ ...TAGGED, ownerRef: "other" });
  assertEquals(
    await refusalReason(
      verifier(repo).verify(
        dispatchWithSpec(),
        { name: TAGGED.name, version: TAGGED.version },
        "default",
        "password-key",
      ),
    ),
    "the record identity does not match the dispatched behavior",
  );
});

Deno.test("ResourceClaimVerifier: a verified claim reads its record once per dispatch", async () => {
  const { repo, reads } = repoHolding(TAGGED);
  const claims = verifier(repo);
  const claim = { name: TAGGED.name, version: TAGGED.version };
  const dispatch = dispatchWithSpec();
  await claims.verify(dispatch, claim, "default", "password-key");
  await claims.verify(dispatch, claim, "default", "password-key");
  assertEquals(reads.count, 1);
  await claims.verify(dispatchWithSpec(), claim, "default", "password-key");
  assertEquals(reads.count, 2);
});
