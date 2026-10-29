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
 * Typed-secrets 5.1: the protected data-plane route a runner loads its
 * dispatch's references through (design/enablers/typed-secrets.md
 * Section 9), against a real orchestrator on a port-0 listener.
 *
 * A reference of the dispatch's own bag loads under a live lease. An
 * out-of-bag or reserved reference, one outside the run's vault access, and
 * forged, control, completed, revoked, reassigned and expired credentials
 * read no value; a read in flight when the dispatch ends gets none either.
 * A resource claim loads a sensitive field of the dispatch's own resource,
 * tagged and verified (swamp-club#3529); a legacy untagged record admits
 * nothing until typed-secrets 5.2 adds the schema fallback. Audit events
 * at every detail level and serve's logs hold no canary.
 */

import "../src/domain/models/models.ts";
import { assertEquals, assertFalse } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { z } from "zod";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Data } from "../src/domain/data/data.ts";
import { defineModel, modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  RECORD_KIND_TAG,
  SENSITIVE_FIELDS_TAG,
  SENSITIVE_FIELDS_VERSION,
  SENSITIVE_FIELDS_VERSION_TAG,
} from "../src/domain/models/data_writer.ts";
import { STEP_LEASE_MODEL_TYPE } from "../src/domain/models/worker/step_lease_model.ts";
import {
  DISPATCH_SECRETS_PATH,
  type DispatchParams,
  type DispatchResult,
  WorkerMethod,
} from "../src/domain/remote/protocol.ts";
import type { RemoteStepRequest } from "../src/domain/remote/remote_dispatch.ts";
import { SessionCredentialService } from "../src/domain/remote/session_credential.ts";
import { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import {
  type AuditLevel,
  AuditPolicy,
} from "../src/domain/serve_audit/audit_policy.ts";
import type { AuditSink } from "../src/domain/serve_audit/audit_sink.ts";
import {
  RunVaultAccess,
  runWithVaultAccess,
} from "../src/domain/vaults/run_vault_access.ts";
import {
  SecretBagRegistry,
  type SecretReference,
} from "../src/domain/vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../src/domain/vaults/vault_secret_bag.ts";
import type { VaultService } from "../src/domain/vaults/vault_service.ts";
import { DISPATCH_SECRET_LOAD_AUDIT_ACTION } from "../src/serve/dispatch_secret_loads.ts";
import {
  BASELINE_VAULT,
  type BaselineOrchestrator,
  type BaselineOrchestratorOptions,
  canary,
  captureLogs,
  connectInMemoryWorker,
  type InMemoryWorker,
  startBaselineOrchestrator,
  withTempDir,
} from "./remote_secrets_baseline_harness.ts";

await initializeLogging({});

const LOAD_TYPE = ModelType.create("swamp/secrets-load-route");
const LOAD_DEFINITION_ID = "4064c0de-0051-4000-8000-000000000051";
const SPEC = "secret";

defineModel({
  type: LOAD_TYPE,
  version: "2026.10.28.1",
  resources: {
    [SPEC]: {
      description: "a resource with one schema-sensitive field",
      schema: z.object({
        password: z.string().meta({ sensitive: true }),
        note: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    run: {
      description: "never runs; the in-memory worker answers the dispatch",
      kind: "action",
      arguments: z.object({}),
      execute: () => Promise.resolve({}),
    },
  },
});

const SUCCESS: DispatchResult = {
  status: "success",
  outputs: [],
  logs: [],
  durationMs: 1,
};

/**
 * The bag references a step's arguments carry, through a real bag: one
 * vault.get() reference and one a typed data read brought in (data
 * origin), as the method execution service derives `secretReferences`.
 */
function bagReferences(vaultKey: string, dataKey: string): SecretReference[] {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const fromVault = bag.addSecret(
    { vaultName: BASELINE_VAULT, key: vaultKey },
    "methodArgs.token",
  );
  const fromData = bag.addDataReference(
    { vaultName: BASELINE_VAULT, key: dataKey },
    "data.latest('db', 'state-main').password",
  );
  return bag.referencesFor({
    methodArgs: { token: fromVault, url: `postgres://u:${fromData}@db` },
    globalArgs: {},
  });
}

function stepRequest(secretReferences: SecretReference[]): RemoteStepRequest {
  return {
    placeArguments: (args) => args,
    placement: { labels: { tier: "baseline" } },
    modelDef: modelRegistry.get(LOAD_TYPE)!,
    modelType: LOAD_TYPE,
    modelId: LOAD_DEFINITION_ID,
    methodName: "run",
    definitionName: "load-route",
    definitionTags: {},
    definitionMeta: {
      id: LOAD_DEFINITION_ID,
      name: "load-route",
      version: 1,
      tags: {},
    },
    globalArgs: {},
    methodArgs: {},
    workflowName: "load-route-workflow",
    stepName: "load-route-step",
    secretReferences,
  };
}

interface HeldDispatch {
  dispatchId: string;
  credential: string;
  settle: (result: DispatchResult) => void;
}

/** Holds each dispatch the worker receives open until the test settles it. */
function holdDispatches(worker: InMemoryWorker): HeldDispatch[] {
  const held: HeldDispatch[] = [];
  worker.channel.register(WorkerMethod.dispatch, (raw) => {
    const params = raw as DispatchParams & { dispatchCredential: string };
    return new Promise<DispatchResult>((resolve) => {
      held.push({
        dispatchId: params.dispatchId,
        credential: params.dispatchCredential,
        settle: resolve,
      });
    });
  });
  return held;
}

/** A reference a load request names. */
interface Requested {
  vaultName: string;
  key: string;
  resource?: { name: string; version: number };
}

interface LoadReply {
  status: number;
  cacheControl: string | null;
  text: string;
  body: {
    values?: { vaultName: string; key: string; value: string }[];
    code?: string;
    reference?: { vaultName: string; key: string };
  };
}

async function load(
  o: BaselineOrchestrator,
  credential: string,
  references: Requested[],
): Promise<LoadReply> {
  const response = await fetch(`${o.dataPlaneUrl}${DISPATCH_SECRETS_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ references }),
  });
  const text = await response.text();
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    text,
    body: JSON.parse(text),
  };
}

/** Counts and can hold the data plane's vault reads. */
function controllableVault() {
  const reads: string[] = [];
  let hold: PromiseWithResolvers<void> | null = null;
  let started = Promise.withResolvers<void>();
  return {
    reads,
    /** Holds the next read until `release`; `started` resolves when it begins. */
    holdNext() {
      hold = Promise.withResolvers<void>();
      started = Promise.withResolvers<void>();
      const held = hold;
      return { started: started.promise, release: () => held.resolve() };
    },
    wrap: (vault: VaultService): VaultService => {
      const get = vault.get.bind(vault);
      vault.get = async (vaultName, key, callerContext) => {
        reads.push(key);
        const held = hold;
        if (held !== null) {
          hold = null;
          started.resolve();
          await held.promise;
        }
        return await get(vaultName, key, callerContext);
      };
      return vault;
    },
  };
}

/**
 * Waits out the control-plane bookkeeping serve writes after a step has
 * settled, so it lands before the temp repo is removed (as the dispatch
 * credential baseline does).
 */
async function drainBookkeeping(o: BaselineOrchestrator): Promise<void> {
  await o.gateway.revokeToken(`drain-${crypto.randomUUID()}`, "revoked");
  const id = crypto.randomUUID();
  await o.dispatchService.recordFirstWrite({
    workerName: "drain",
    dispatchId: id,
    leaseId: id,
    modelDef: modelRegistry.get(LOAD_TYPE)!,
    modelType: LOAD_TYPE,
    modelId: LOAD_DEFINITION_ID,
    methodName: "run",
    definitionName: "load-route",
    definitionTags: {},
  }).catch(() => {});
}

interface Fixture {
  o: BaselineOrchestrator;
  vault: ReturnType<typeof controllableVault>;
  vaultKey: string;
  dataKey: string;
  vaultSecret: string;
  dataSecret: string;
  inBag: Requested[];
}

async function withFixture(
  fn: (f: Fixture) => Promise<void>,
  options: BaselineOrchestratorOptions = {},
): Promise<void> {
  await withTempDir(async (dir) => {
    const vault = controllableVault();
    const o = await startBaselineOrchestrator(dir, {
      ...options,
      wrapDataPlaneVault: vault.wrap,
    });
    try {
      const vaultKey = `load-vault-${crypto.randomUUID()}`;
      const dataKey = `load-data-${crypto.randomUUID()}`;
      const vaultSecret = canary("load-vault");
      const dataSecret = canary("load-data");
      await o.putSecret(vaultKey, vaultSecret);
      await o.putSecret(dataKey, dataSecret);
      await fn({
        o,
        vault,
        vaultKey,
        dataKey,
        vaultSecret,
        dataSecret,
        inBag: [
          { vaultName: BASELINE_VAULT, key: vaultKey },
          { vaultName: BASELINE_VAULT, key: dataKey },
        ],
      });
      await drainBookkeeping(o);
    } finally {
      await o.shutdown();
    }
  });
}

/** Starts a dispatch of the fixture's bag and waits for the worker to hold it. */
async function startDispatch(
  f: Fixture,
  workerName: string,
  wrap: (start: () => Promise<unknown>) => Promise<unknown> = (start) =>
    start(),
): Promise<{
  worker: InMemoryWorker;
  held: HeldDispatch[];
  step: Promise<unknown>;
}> {
  const worker = await connectInMemoryWorker(f.o, workerName);
  const held = holdDispatches(worker);
  const step = wrap(() =>
    f.o.dispatchService.executeRemote(
      stepRequest(bagReferences(f.vaultKey, f.dataKey)),
    )
  );
  await waitFor(() => held.length === 1, "the dispatch reached the worker");
  return { worker, held, step };
}

Deno.test({
  name:
    "secret load route: the dispatch's own bag loads under a live lease, each reference once, and joins the dispatch redactor",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withFixture(async (f) => {
      const { held, step } = await startDispatch(f, "load-live");
      const [dispatch] = held;

      const reply = await load(f.o, dispatch.credential, [
        ...f.inBag,
        f.inBag[0],
      ]);
      assertEquals(reply.status, 200);
      assertEquals(reply.cacheControl, "no-store");
      assertEquals(reply.body.values, [
        { vaultName: BASELINE_VAULT, key: f.vaultKey, value: f.vaultSecret },
        { vaultName: BASELINE_VAULT, key: f.dataKey, value: f.dataSecret },
      ]);
      // The repeated reference was read once.
      assertEquals(f.vault.reads, [f.vaultKey, f.dataKey]);
      const redactor = f.o.dispatches.forDispatch(
        "load-live",
        dispatch.dispatchId,
      )?.redactor;
      assertEquals(
        redactor?.redact(`${f.vaultSecret} ${f.dataSecret}`),
        "*** ***",
      );

      dispatch.settle(SUCCESS);
      await step;
    });
  },
});

Deno.test({
  name:
    "secret load route: an out-of-bag or reserved reference, or one outside the run's vault access, reads no value",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withFixture(async (f) => {
      const { held, step } = await startDispatch(f, "load-refused");
      const [dispatch] = held;
      const outside = { vaultName: BASELINE_VAULT, key: `other-${f.vaultKey}` };
      await f.o.putSecret(outside.key, canary("load-outside"));

      const outOfBag = await load(f.o, dispatch.credential, [
        f.inBag[0],
        outside,
      ]);
      assertEquals([outOfBag.status, outOfBag.body.code], [
        403,
        "not_in_dispatch",
      ]);
      assertEquals(outOfBag.body.reference, outside);
      assertEquals(outOfBag.body.values, undefined);
      assertEquals(outOfBag.cacheControl, "no-store");

      const reserved = await load(f.o, dispatch.credential, [{
        vaultName: BASELINE_VAULT,
        key: "server-token-anything",
      }]);
      assertEquals([reserved.status, reserved.body.code], [
        403,
        "reserved_secret",
      ]);
      assertEquals(f.vault.reads, []);

      dispatch.settle(SUCCESS);
      await step;
    });

    await withFixture(async (f) => {
      // The dispatching run may read only another vault.
      const { held, step } = await startDispatch(
        f,
        "load-scoped",
        (start) =>
          runWithVaultAccess(
            RunVaultAccess.create({ allowedVaults: ["elsewhere"] }),
            start,
          ),
      );
      const [dispatch] = held;
      const scoped = await load(f.o, dispatch.credential, [f.inBag[0]]);
      assertEquals([scoped.status, scoped.body.code], [
        403,
        "vault_access_denied",
      ]);
      assertFalse(scoped.text.includes(f.vaultSecret));

      dispatch.settle(SUCCESS);
      await step;
    });
  },
});

Deno.test({
  name:
    "secret load route: forged, control, completed and revoked credentials read no value",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withFixture(async (f) => {
      const { worker, held, step } = await startDispatch(f, "load-creds");
      const [dispatch] = held;

      for (
        const credential of [
          "forged",
          worker.enrollResult.sessionCredential,
        ]
      ) {
        const reply = await load(f.o, credential, f.inBag);
        assertEquals(reply.status, 401);
        assertEquals(reply.cacheControl, "no-store");
      }

      dispatch.settle(SUCCESS);
      await step;
      const completed = await load(f.o, dispatch.credential, f.inBag);
      assertEquals(completed.status, 401);
      assertEquals(f.vault.reads, []);
    });

    await withFixture(async (f) => {
      const { held, step } = await startDispatch(f, "load-revoked");
      const [dispatch] = held;
      await f.o.gateway.revokeToken("load-revoked", "revoked");
      const revoked = await load(f.o, dispatch.credential, f.inBag);
      assertEquals(revoked.status, 401);
      assertEquals(f.vault.reads, []);

      // The attempt wrote nothing, so the step is re-queued for the next
      // worker to enroll.
      const next = await connectInMemoryWorker(f.o, "load-revoked-next");
      const nextHeld = holdDispatches(next);
      await waitFor(() => nextHeld.length === 1, "the step was re-queued");
      nextHeld[0].settle(SUCCESS);
      await step;
    });
  },
});

Deno.test({
  name:
    "secret load route: a reassigned attempt's old credential reads no value, and the new attempt reads its own",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withFixture(async (f) => {
      const workers = [
        await connectInMemoryWorker(f.o, "load-drop-a"),
        await connectInMemoryWorker(f.o, "load-drop-b"),
      ];
      const held = workers.map(holdDispatches);
      const step = f.o.dispatchService.executeRemote(
        stepRequest(bagReferences(f.vaultKey, f.dataKey)),
      );
      await waitFor(
        () => held[0].length + held[1].length === 1,
        "the dispatch reached a worker",
      );
      const first = held[0].length === 1 ? 0 : 1;
      const old = held[first][0];
      workers[first].dropSocket();
      await waitFor(
        () => held[1 - first].length === 1,
        "the step was dispatched again to the other worker",
        { timeoutMs: 15_000 },
      );
      const retry = held[1 - first][0];

      const stale = await load(f.o, old.credential, f.inBag);
      assertEquals(stale.status, 401);
      const fresh = await load(f.o, retry.credential, f.inBag);
      assertEquals(fresh.status, 200);

      retry.settle(SUCCESS);
      await step;
    });
  },
});

Deno.test({
  name: "secret load route: an expired dispatch credential reads no value",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Dispatch credentials refresh until revoked, so expiry needs the clock
    // to pass the lifetime with no refresh running.
    let now = Date.now();
    const sessions = new SessionCredentialService({
      ttlMs: 60_000,
      now: () => now,
      setInterval: () => 0,
      clearInterval: () => {},
    });
    await withFixture(async (f) => {
      const { held, step } = await startDispatch(f, "load-expired");
      const [dispatch] = held;
      assertEquals((await load(f.o, dispatch.credential, f.inBag)).status, 200);
      now += 60_001;
      const expired = await load(f.o, dispatch.credential, f.inBag);
      assertEquals(expired.status, 401);
      assertEquals(f.vault.reads.length, 2);
      dispatch.settle(SUCCESS);
      await step;
    }, { sessionCredentials: sessions });
  },
});

Deno.test({
  name:
    "secret load route: a read in flight gets no value when the dispatch completes, its token is revoked or its worker drops",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const endings: {
      name: string;
      end: (
        f: Fixture,
        dispatch: HeldDispatch,
        worker: InMemoryWorker,
        workerName: string,
      ) => Promise<void>;
      finish: (
        f: Fixture,
        step: Promise<unknown>,
        dispatch: HeldDispatch,
      ) => Promise<void>;
    }[] = [
      {
        name: "completion",
        end: async (f, dispatch) => {
          dispatch.settle(SUCCESS);
          await waitFor(
            () => f.o.gateway.sessions.verify(dispatch.credential) === null,
            "the completed dispatch's credential was revoked",
          );
        },
        finish: async (_f, step) => {
          await step;
        },
      },
      {
        name: "revocation",
        end: async (f, _dispatch, _worker, workerName) => {
          await f.o.gateway.revokeToken(workerName, "revoked");
        },
        finish: async (f, step) => {
          const next = await connectInMemoryWorker(
            f.o,
            `next-${crypto.randomUUID()}`,
          );
          const nextHeld = holdDispatches(next);
          await waitFor(() => nextHeld.length === 1, "the step was re-queued");
          nextHeld[0].settle(SUCCESS);
          await step;
        },
      },
      {
        name: "a dropped worker",
        end: async (f, dispatch, worker) => {
          worker.dropSocket();
          await waitFor(
            () => f.o.gateway.sessions.verify(dispatch.credential) === null,
            "the dropped attempt's credential was revoked",
          );
        },
        finish: async (f, step) => {
          const next = await connectInMemoryWorker(
            f.o,
            `next-${crypto.randomUUID()}`,
          );
          const nextHeld = holdDispatches(next);
          await waitFor(() => nextHeld.length === 1, "the step was re-queued", {
            timeoutMs: 15_000,
          });
          nextHeld[0].settle(SUCCESS);
          await step;
        },
      },
    ];
    for (const ending of endings) {
      await withFixture(async (f) => {
        const workerName = `load-inflight-${crypto.randomUUID()}`;
        const { worker, held, step } = await startDispatch(f, workerName);
        const [dispatch] = held;
        const registration = f.o.dispatches.forDispatch(
          workerName,
          dispatch.dispatchId,
        );
        const gate = f.vault.holdNext();
        const pending = load(f.o, dispatch.credential, f.inBag);
        await gate.started;
        await ending.end(f, dispatch, worker, workerName);
        gate.release();
        const reply = await pending;
        assertEquals(
          [reply.status, reply.body.code],
          [410, "access_ended"],
          `ending by ${ending.name}`,
        );
        assertFalse(reply.text.includes(f.vaultSecret));
        assertFalse(reply.text.includes(f.dataSecret));
        // Nothing was delivered, so the dispatch's redactor learned nothing.
        assertEquals(registration?.redactor, undefined);
        await ending.finish(f, step, dispatch);
      });
    }
  },
});

Deno.test({
  name:
    "secret load route: the dispatch credential is revoked before the lease ends, so the route never answers past the lease",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withFixture(async (f) => {
      const { held, step } = await startDispatch(f, "load-ordering");
      const [dispatch] = held;
      const repo = f.o.repoContext.unifiedDataRepo;
      const save = repo.save.bind(repo);
      const atLeaseEnd: boolean[] = [];
      const decoder = new TextDecoder();
      repo.save = ((...args: Parameters<typeof repo.save>) => {
        const [type, , , content] = args;
        if (
          type.normalized === STEP_LEASE_MODEL_TYPE.normalized &&
          content instanceof Uint8Array
        ) {
          const lease = JSON.parse(decoder.decode(content));
          if (lease.state !== "active") {
            atLeaseEnd.push(
              f.o.gateway.sessions.verify(dispatch.credential) === null,
            );
          }
        }
        return save(...args);
      }) as typeof repo.save;
      try {
        dispatch.settle(SUCCESS);
        await step;
      } finally {
        repo.save = save;
      }
      // The lease's end was written, and the credential no longer verified
      // when it was.
      assertEquals(atLeaseEnd, [true]);
    });
  },
});

/** Seeds a resource record of `modelId` with `tags`, version 1. */
async function seedResource(
  o: BaselineOrchestrator,
  modelId: string,
  name: string,
  content: Record<string, unknown>,
  tags: Record<string, string>,
): Promise<void> {
  const data = Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource", specName: SPEC, ...tags },
    ownerDefinition: { ownerType: "model-method", ownerRef: modelId },
  });
  await o.repoContext.unifiedDataRepo.save(
    LOAD_TYPE,
    modelId,
    data,
    new TextEncoder().encode(JSON.stringify(content)),
  );
}

function vaultRef(key: string): string {
  return `\${{ vault.get('${BASELINE_VAULT}', '${key}') }}`;
}

const TAGGED = {
  [RECORD_KIND_TAG]: "resource",
  [SENSITIVE_FIELDS_TAG]: JSON.stringify(["password"]),
  [SENSITIVE_FIELDS_VERSION_TAG]: SENSITIVE_FIELDS_VERSION,
};

Deno.test({
  name:
    "secret load route: a resource claim loads a tagged sensitive field of the dispatch's own resource, and nothing else",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withFixture(async (f) => {
      const keys = {
        tagged: `rr-tagged-${crypto.randomUUID()}`,
        legacy: `rr-legacy-${crypto.randomUUID()}`,
        note: `rr-note-${crypto.randomUUID()}`,
        foreign: `rr-foreign-${crypto.randomUUID()}`,
        forged: `rr-forged-${crypto.randomUUID()}`,
      };
      const secrets = new Map<string, string>();
      for (const key of Object.values(keys)) {
        secrets.set(key, canary("claim"));
        await f.o.putSecret(key, secrets.get(key)!);
      }
      await seedResource(f.o, LOAD_DEFINITION_ID, "tagged", {
        password: vaultRef(keys.tagged),
        note: "n",
      }, TAGGED);
      // Written before the writers stamped _swamp.kind: no tag at all. The
      // spec marks the password sensitive, but the record predates the writer
      // guards, so its text may never have been vaulted (typed-secrets 5.2
      // decides the schema fallback).
      await seedResource(f.o, LOAD_DEFINITION_ID, "legacy", {
        password: vaultRef(keys.legacy),
        note: vaultRef(keys.note),
      }, {});
      // Another behavior's record of the same name.
      await seedResource(f.o, crypto.randomUUID(), "foreign", {
        password: vaultRef(keys.foreign),
        note: "n",
      }, TAGGED);
      // A current writer's record with no sensitive-fields tag.
      await seedResource(f.o, LOAD_DEFINITION_ID, "forged", {
        password: vaultRef(keys.forged),
        note: "n",
      }, { [RECORD_KIND_TAG]: "resource" });

      const { held, step } = await startDispatch(f, "load-claims");
      const [dispatch] = held;
      const claim = (key: string, name: string): Requested => ({
        vaultName: BASELINE_VAULT,
        key,
        resource: { name, version: 1 },
      });

      const tagged = await load(f.o, dispatch.credential, [
        claim(keys.tagged, "tagged"),
      ]);
      assertEquals(tagged.status, 200);
      assertEquals(tagged.body.values?.[0].value, secrets.get(keys.tagged));

      for (
        const [key, name] of [
          [keys.legacy, "legacy"],
          [keys.note, "legacy"],
          [keys.foreign, "foreign"],
          [keys.forged, "forged"],
          [keys.tagged, "legacy"],
        ]
      ) {
        const refused = await load(f.o, dispatch.credential, [
          claim(key, name),
        ]);
        assertEquals(
          [refused.status, refused.body.code],
          [403, "resource_claim_refused"],
          `${name}: ${key}`,
        );
        assertFalse(refused.text.includes("canary-"));
      }

      dispatch.settle(SUCCESS);
      await step;
    });
  },
});

function captureSink(): AuditSink & { events: AuditEvent[] } {
  const sink = {
    name: "capture",
    durable: true,
    events: [] as AuditEvent[],
    write(events: readonly AuditEvent[]): Promise<void> {
      sink.events.push(...events);
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return sink;
}

Deno.test({
  name:
    "secret load route: audit records at every detail level and serve's logs hold no canary",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const levels: AuditLevel[] = [
      "none",
      "metadata",
      "request",
      "requestResponse",
    ];
    for (const level of levels) {
      await withFixture(async (f) => {
        const sink = captureSink();
        const emitter = new AuditEmitter({
          sinks: [sink],
          policy: new AuditPolicy([], level),
        });
        f.o.dataPlane.setAudit(() => ({ emitter, instanceId: "serve-test" }));
        const { held, step } = await startDispatch(
          f,
          `load-audit-${level.toLowerCase()}`,
        );
        const [dispatch] = held;

        const logs = await captureLogs(async () => {
          assertEquals(
            (await load(f.o, dispatch.credential, f.inBag)).status,
            200,
          );
          const outside = await load(f.o, dispatch.credential, [{
            vaultName: BASELINE_VAULT,
            key: "not-in-bag",
          }]);
          assertEquals(outside.status, 403);
          assertEquals((await load(f.o, "forged", f.inBag)).status, 401);
          // A read in flight when the dispatch ends logs its refusal.
          const gate = f.vault.holdNext();
          const pending = load(f.o, dispatch.credential, f.inBag);
          await gate.started;
          dispatch.settle(SUCCESS);
          await waitFor(
            () => f.o.gateway.sessions.verify(dispatch.credential) === null,
            "the dispatch's credential was revoked",
          );
          gate.release();
          assertEquals((await pending).status, 410);
          await step;
        });
        await emitter.flush();

        const recorded = sink.events.filter((e) =>
          e.action === DISPATCH_SECRET_LOAD_AUDIT_ACTION
        );
        assertEquals(recorded.length, level === "none" ? 0 : 4, level);
        const audited = JSON.stringify(sink.events);
        const logged = JSON.stringify(logs);
        for (const secret of [f.vaultSecret, f.dataSecret]) {
          assertFalse(audited.includes(secret), `audit at ${level}`);
          assertFalse(logged.includes(secret), `logs at ${level}`);
        }
        await emitter.close();
      });
    }
  },
});
