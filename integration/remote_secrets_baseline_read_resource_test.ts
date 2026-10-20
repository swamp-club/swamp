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

/**
 * Remote-secrets baseline, path 2: remote `readResource` (swamp-club#3512).
 *
 * The runner's `createRemoteMethodContext` reads through the real capability
 * bridge (runner channel → supervisor bridge → serve CapabilityService, with
 * the dispatch registry wired as `swamp serve` wires it) and a real
 * DataPlaneClient holding a per-dispatch credential against the harness's
 * port-0 data plane. Pins how serve authorizes tagged fields through a
 * resource claim verified against the record (swamp-club#3529), and that the
 * remote reader, fed the verified bundle's resource specs, reads an untagged
 * record and a malformed sensitive-fields tag as the local reader does
 * (swamp-club#3530).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { ResourceOutputSpec } from "../src/domain/models/model.ts";
import {
  createResourceReader,
  SENSITIVE_FIELDS_TAG,
} from "../src/domain/models/data_writer.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { ResourceSensitiveFieldsInvalidError } from "../src/domain/vaults/secret_reference_errors.ts";
import { SecretRedactor } from "../src/domain/secrets/secret_redactor.ts";
import { extractVaultReferences } from "../src/domain/expressions/vault_reference_extractor.ts";
import type { VaultExtractionResult } from "../src/domain/expressions/vault_reference_extractor.ts";
import { RpcChannel } from "../src/domain/remote/rpc_channel.ts";
import {
  type DispatchParams,
  REMOTE_PROTOCOL_VERSION,
} from "../src/domain/remote/protocol.ts";
import { bridgeCapabilityVerbs } from "../src/worker/runner_bridge.ts";
import { DataPlaneClient } from "../src/worker/data_plane_client.ts";
import { createRemoteMethodContext } from "../src/worker/remote_method_context.ts";
import { dataContentPath } from "../src/serve/capability_service.ts";
import {
  BASELINE_VAULT,
  type BaselineOrchestrator,
  canary,
  startBaselineOrchestrator,
  withTempDir,
} from "./remote_secrets_baseline_harness.ts";

await initializeLogging({});

const WORKER = "w-read-resource";
const SPEC = "secret";

/** The resource spec both readers see: `password` is schema-sensitive. */
const RESOURCE_SPECS: Record<string, ResourceOutputSpec> = {
  [SPEC]: {
    description: "a resource with one sensitive field",
    schema: z.object({
      password: z.string().meta({ sensitive: true }),
      note: z.string(),
    }),
    lifetime: "infinite",
    garbageCollection: 5,
  },
};

interface Fixture {
  o: BaselineOrchestrator;
  typeA: ModelType;
  modelIdA: string;
  typeB: ModelType;
  modelIdB: string;
  dispatchId: string;
  /** The runner-side method context for a dispatch of model A. */
  context: ReturnType<typeof createRemoteMethodContext>["context"];
  /** The dispatch's per-dispatch data-plane credential. */
  credential: string;
}

function vaultRef(key: string): string {
  return `\${{ vault.get('${BASELINE_VAULT}', '${key}') }}`;
}

async function seedResource(
  o: BaselineOrchestrator,
  type: ModelType,
  modelId: string,
  name: string,
  content: Record<string, unknown>,
  extraTags: Record<string, string> = {},
): Promise<void> {
  const data = Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource", specName: SPEC, ...extraTags },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${type.normalized}:${modelId}`,
    },
  });
  await o.repoContext.unifiedDataRepo.save(
    type,
    modelId,
    data,
    new TextEncoder().encode(JSON.stringify(content)),
  );
}

/** Wires one in-process channel pair; each side delivers to the other. */
function channelPair(): [RpcChannel, RpcChannel] {
  const a: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => b.handleRaw(data)),
  });
  const b: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => a.handleRaw(data)),
  });
  return [a, b];
}

/**
 * Registers a dispatch of model A for the worker and builds the runner's
 * remote method context over the production verb path. `allowedSecrets`
 * defaults to what DispatchService derives for a step whose (resolved) args
 * carry no vault expression: an empty allowlist. `null` registers no
 * allowlist at all, which CapabilityService treats as allow-all (`undefined`
 * would take the default instead).
 */
async function withFixture(
  fn: (f: Fixture) => Promise<void>,
  allowedSecrets: VaultExtractionResult | null = extractVaultReferences(
    {},
    {},
  ),
): Promise<void> {
  await withTempDir(async (dir) => {
    const o = await startBaselineOrchestrator(dir);
    const abort = new AbortController();
    const suffix = crypto.randomUUID().slice(0, 8);
    const typeA = ModelType.create(`test/baseline-rr-a-${suffix}`);
    const typeB = ModelType.create(`test/baseline-rr-b-${suffix}`);
    const modelIdA = crypto.randomUUID();
    const modelIdB = crypto.randomUUID();
    const dispatchId = `d-${crypto.randomUUID()}`;
    try {
      o.dispatches.register({
        workerName: WORKER,
        dispatchId,
        leaseId: `l-${dispatchId}`,
        modelDef: {} as never,
        modelType: typeA,
        modelId: modelIdA,
        methodName: "run",
        definitionName: "baseline-rr",
        definitionTags: {},
        allowedSecrets: allowedSecrets ?? undefined,
      });
      const record = o.gateway.sessions.issueForDispatch(WORKER, dispatchId);

      // serve ⇄ supervisor over the control socket; supervisor ⇄ runner
      // over stdio. The bridge stamps its own dispatchId on every verb.
      const [serveSide, supervisorSide] = channelPair();
      o.capabilityService.registerHandlers(serveSide, WORKER);
      const [bridgeChild, runner] = channelPair();
      bridgeCapabilityVerbs({
        childChannel: bridgeChild,
        orchestratorChannel: supervisorSide,
        dispatchId,
        signal: abort.signal,
      });
      const client = new DataPlaneClient({
        baseUrl: o.dataPlaneUrl,
        credential: () => record.credential,
      });
      const dispatch: DispatchParams = {
        dispatchId,
        leaseId: `l-${dispatchId}`,
        execution: {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          modelType: typeA.normalized,
          modelId: modelIdA,
          methodName: "run",
          globalArgs: {},
          methodArgs: {},
          definitionMeta: {
            id: modelIdA,
            name: "baseline-rr",
            version: 1,
            tags: {},
          },
        },
        bundleFingerprint: "builtin:baseline",
        reportBundleFingerprints: [],
        environmentSnapshot: {},
      };
      const { context } = createRemoteMethodContext({
        channel: runner,
        client,
        dispatch,
        scratchDir: dir,
        resourceSpecs: RESOURCE_SPECS,
        signal: abort.signal,
      });
      await fn({
        o,
        typeA,
        modelIdA,
        typeB,
        modelIdB,
        dispatchId,
        context,
        credential: record.credential,
      });
    } finally {
      abort.abort();
      o.gateway.sessions.revokeDispatch(WORKER, dispatchId);
      o.dispatches.unregister(WORKER, dispatchId);
      await o.shutdown();
    }
  });
}

/** The local reader, wired as in_process_executor wires it. */
async function readLocally(
  f: Fixture,
  name: string,
): Promise<Record<string, unknown> | null> {
  const vault = await VaultService.fromRepository(f.o.repoDir);
  return await createResourceReader(
    f.o.repoContext.unifiedDataRepo,
    f.typeA,
    f.modelIdA,
    vault,
    new SecretRedactor(),
    RESOURCE_SPECS,
  )(name);
}

Deno.test({
  name:
    "remote secrets baseline: readResource: getData is held to the dispatch's behavior type",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withFixture(async (f) => {
      await seedResource(f.o, f.typeA, f.modelIdA, "own", { note: "a" });
      await seedResource(f.o, f.typeB, f.modelIdB, "other", { note: "b" });

      assertEquals(await f.context.readResource!("own"), { note: "a" });

      // A read of another behavior type through the verb path is refused.
      const repo = f.context.dataRepository;
      await assertRejects(
        () => repo.findByName(f.typeB, f.modelIdB, "other"),
        Error,
        `getData: behavior type '${f.typeB.normalized}' is outside the active dispatch scope`,
      );
    });
  },
});

Deno.test({
  name:
    "remote secrets baseline: readResource: the data-plane bytes read is held to the dispatch's behavior type",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withFixture(async (f) => {
      const otherSecret = canary("rr-bytes");
      await seedResource(f.o, f.typeB, f.modelIdB, "other", {
        note: otherSecret,
      });

      // The bytes route repeats getData's check (swamp-club#3528): a
      // dispatch of model A asking for model B's stored bytes with its own
      // credential is refused before the lookup, with the same phrase, and
      // none of B's content leaves serve.
      const response = await fetch(
        `${f.o.dataPlaneUrl}${
          dataContentPath(f.typeB.normalized, f.modelIdB, "other", 1)
        }`,
        { headers: { authorization: `Bearer ${f.credential}` } },
      );
      assertEquals(response.status, 403);
      const body = await response.text();
      assertStringIncludes(
        body,
        `Behavior type '${f.typeB.normalized}' is outside the active dispatch scope`,
      );
      assertEquals(body.includes(otherSecret), false);
    });
  },
});

Deno.test({
  name:
    "remote secrets baseline: readResource: a tagged sensitive field resolves through a resource claim serve verifies against the record, with the allowlist empty (swamp-club#3529)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const key = `rr-tagged-${crypto.randomUUID()}`;
    const secret = canary("rr-tagged");
    const other = `rr-other-${crypto.randomUUID()}`;
    await withFixture(async (f) => {
      await f.o.putSecret(key, secret);
      await f.o.putSecret(other, canary("rr-other"));
      await seedResource(f.o, f.typeA, f.modelIdA, "tagged", {
        password: vaultRef(key),
        note: "n",
      }, { [SENSITIVE_FIELDS_TAG]: JSON.stringify(["password"]) });
      await seedResource(f.o, f.typeA, f.modelIdA, "plain", {
        password: vaultRef(other),
        note: "n",
      });

      // The allowlist a workflow step's dispatch registers is empty, so the
      // read resolves only because the reader claims the record it is for
      // and serve verifies the claim against that record's tagged fields.
      assertEquals(await f.context.readResource!("tagged"), {
        password: secret,
        note: "n",
      });

      const resolve = (
        secretKey: string,
        resource?: { name: string; version: number },
      ) =>
        f.o.capabilityService.resolveSecret(WORKER, {
          vaultName: BASELINE_VAULT,
          secretKey,
          dispatchId: f.dispatchId,
          ...(resource ? { resource } : {}),
        });
      // Without a claim, the empty allowlist refuses the same key.
      await assertRejects(
        () => resolve(key),
        Error,
        `resolveSecret: secret '${key}' is not referenced by the dispatched step`,
      );
      // A claim is verified against the record: a resource the dispatch
      // does not have, a reference the tagged fields do not hold, an
      // untagged record, and a wrong version are each refused.
      const refused = (k: string, name: string, reason: string) =>
        `resolveSecret: secret '${k}' is not a tagged sensitive field of resource '${name}' (${reason})`;
      await assertRejects(
        () => resolve(key, { name: "missing", version: 1 }),
        Error,
        refused(key, "missing", "no such resource of the dispatched behavior"),
      );
      await assertRejects(
        () => resolve(other, { name: "tagged", version: 1 }),
        Error,
        refused(other, "tagged", "its sensitive fields do not reference it"),
      );
      await assertRejects(
        () => resolve(other, { name: "plain", version: 1 }),
        Error,
        refused(other, "plain", "the record has no sensitive fields"),
      );
      await assertRejects(
        () => resolve(key, { name: "tagged", version: 2 }),
        Error,
        refused(key, "tagged", "no such resource of the dispatched behavior"),
      );
    });
  },
});

Deno.test({
  name:
    "remote secrets baseline: readResource: an untagged record resolves from the resource schema remotely as locally (swamp-club#3530)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const key = `rr-untagged-${crypto.randomUUID()}`;
    const secret = canary("rr-untagged");
    // No allowlist at all, so the resolveSecret the remote reader issues for
    // the schema-sensitive field is allowed. Under a dispatch's default empty
    // allowlist serve refuses it (swamp-club#3529), as for a tagged field: the
    // read then fails loudly where, before swamp-club#3530, it returned the
    // raw reference text.
    await withFixture(async (f) => {
      await f.o.putSecret(key, secret);
      await seedResource(f.o, f.typeA, f.modelIdA, "untagged", {
        password: vaultRef(key),
        note: "n",
      });

      // Both readers fall back to the resource schema and resolve it.
      assertEquals(await f.context.readResource!("untagged"), {
        password: secret,
        note: "n",
      });
      assertEquals(await readLocally(f, "untagged"), {
        password: secret,
        note: "n",
      });
    }, null);
  },
});

Deno.test({
  name:
    "remote secrets baseline: readResource: a malformed sensitive-fields tag fails the read on both executors (swamp-club#3530)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    for (const malformed of ['["password"', "[1,2]"]) {
      const key = `rr-malformed-${crypto.randomUUID()}`;
      const secret = canary("rr-malformed");
      await withFixture(async (f) => {
        await f.o.putSecret(key, secret);
        await seedResource(f.o, f.typeA, f.modelIdA, "malformed", {
          password: vaultRef(key),
          note: "n",
        }, { [SENSITIVE_FIELDS_TAG]: malformed });

        // A present tag that is not the vaulting step's is refused rather
        // than read as absent, on both executors, with the refusal naming
        // the record (typed-secrets Section 6.1).
        for (
          const read of [
            () => f.context.readResource!("malformed"),
            () => readLocally(f, "malformed"),
          ]
        ) {
          const error = await assertRejects(
            read,
            ResourceSensitiveFieldsInvalidError,
            "malformed",
          );
          assertEquals(error.code, "secret_reference_invalid", malformed);
        }
      }, null);
    }
  },
});
