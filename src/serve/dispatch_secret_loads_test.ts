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

import { assert, assertEquals, assertFalse } from "@std/assert";
import { computeChecksum } from "../domain/models/checksum.ts";
import {
  RECORD_KIND_TAG,
  SENSITIVE_FIELDS_TAG,
  SENSITIVE_FIELDS_VERSION,
  SENSITIVE_FIELDS_VERSION_TAG,
} from "../domain/models/data_writer.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { UnifiedDataRepository } from "../domain/data/repositories.ts";
import {
  DISPATCH_SECRETS_PATH,
  MAX_DISPATCH_SECRET_CLAIMS,
  MAX_DISPATCH_SECRET_LOAD_BODY_BYTES,
} from "../domain/remote/protocol.ts";
import {
  DEFAULT_SESSION_TTL_MS,
  SessionCredentialService,
} from "../domain/remote/session_credential.ts";
import { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../domain/serve_audit/audit_event.ts";
import { SecretRedactor } from "../domain/secrets/secret_redactor.ts";
import {
  currentVaultAccess,
  RunVaultAccess,
} from "../domain/vaults/run_vault_access.ts";
import type { VaultService } from "../domain/vaults/vault_service.ts";
import {
  type ActiveDispatch,
  bagReferenceSet,
  DispatchRegistry,
} from "./dispatch_registry.ts";
import {
  DISPATCH_SECRET_LOAD_AUDIT_ACTION,
  DispatchSecretLoads,
  isDispatchSecretsRoute,
} from "./dispatch_secret_loads.ts";

const SECRET = "cnr-unit-load-value-7f3a";
const MODEL_TYPE = ModelType.create("acme/loads");

interface Fixture {
  loads: DispatchSecretLoads;
  sessions: SessionCredentialService;
  dispatches: DispatchRegistry;
  dispatch: ActiveDispatch;
  credential: string;
  reads: string[];
  events: AuditEvent[];
  /** Resolves when the next vault read starts; the read waits on `release`. */
  gate?: { started: Promise<void>; release: () => void };
}

interface FixtureOptions {
  bag?: { vaultName: string; key: string }[];
  vaultAccess?: RunVaultAccess;
  /** Hold every vault read until the test releases it. */
  gated?: boolean;
  vaultError?: Error;
  repo?: UnifiedDataRepository;
}

function fixture(options: FixtureOptions = {}): Fixture {
  // No refresh timer runs: the test never waits on one.
  const sessions = new SessionCredentialService({
    setInterval: () => 0,
    clearInterval: () => {},
  });
  const dispatches = new DispatchRegistry();
  const dispatch: ActiveDispatch = {
    workerName: "worker-1",
    dispatchId: crypto.randomUUID(),
    leaseId: "lease-1",
    modelDef: {} as never,
    modelType: MODEL_TYPE,
    modelId: "model-1",
    methodName: "run",
    definitionName: "loads",
    definitionTags: {},
    bagReferences: bagReferenceSet(
      options.bag ?? [{ vaultName: "default", key: "db-password" }],
    ),
    vaultAccess: options.vaultAccess,
  };
  dispatches.register(dispatch);
  const credential = sessions.issueForDispatch(
    dispatch.workerName,
    dispatch.dispatchId,
  ).credential;
  const reads: string[] = [];
  const events: AuditEvent[] = [];
  let gate: Fixture["gate"];
  let started = Promise.withResolvers<void>();
  let release = Promise.withResolvers<void>();
  if (options.gated) {
    gate = {
      started: started.promise,
      release: () => release.resolve(),
    };
  }
  const vault = {
    get: async (vaultName: string, key: string) => {
      await (currentVaultAccess()?.check(vaultName, "read") ??
        Promise.resolve());
      reads.push(`${vaultName}/${key}`);
      if (options.gated) {
        started.resolve();
        await release.promise;
        started = Promise.withResolvers<void>();
        release = Promise.withResolvers<void>();
      }
      if (options.vaultError) throw options.vaultError;
      return `${SECRET}:${key}`;
    },
  } as unknown as VaultService;
  const loads = new DispatchSecretLoads({
    sessions,
    dispatches,
    vault: () => Promise.resolve(vault),
    repoFor: () => options.repo ?? ({} as UnifiedDataRepository),
    audit: () => ({
      emitter: {
        emit: (e: AuditEvent) => events.push(e),
      } as unknown as AuditEmitter,
      instanceId: "serve-1",
    }),
  });
  return {
    loads,
    sessions,
    dispatches,
    dispatch,
    credential,
    reads,
    events,
    gate,
  };
}

function request(
  body: unknown,
  credential: string | null,
  init: { method?: string; raw?: BodyInit; headers?: HeadersInit } = {},
): Request {
  const headers = new Headers(init.headers);
  if (credential !== null) headers.set("authorization", `Bearer ${credential}`);
  return new Request(`http://serve.test${DISPATCH_SECRETS_PATH}`, {
    method: init.method ?? "POST",
    headers,
    body: init.method === "GET" ? undefined : init.raw ?? JSON.stringify(body),
  });
}

function load(f: Fixture, req: Request): Promise<Response> {
  return f.loads.handle(req, "127.0.0.1", (_caller, fn) => fn());
}

const IN_BAG = { vaultName: "default", key: "db-password" };

async function refusalOf(
  response: Response,
): Promise<{ status: number; code: string; text: string }> {
  const text = await response.text();
  return { status: response.status, code: JSON.parse(text).code, text };
}

Deno.test("isDispatchSecretsRoute: matches the route's path only", () => {
  assert(isDispatchSecretsRoute(["data", "secrets"]));
  assertFalse(isDispatchSecretsRoute(["data", "secrets", "x"]));
  assertFalse(isDispatchSecretsRoute(["data", "resource"]));
});

Deno.test("DispatchSecretLoads: an in-bag reference loads, joins the dispatch redactor and is not stored", async () => {
  const f = fixture();
  const response = await load(
    f,
    request({ references: [IN_BAG] }, f.credential),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(await response.json(), {
    values: [{ ...IN_BAG, value: `${SECRET}:db-password` }],
  });
  assert(f.dispatch.redactor instanceof SecretRedactor);
  assertEquals(
    f.dispatch.redactor.redact(`x ${SECRET}:db-password y`),
    "x *** y",
  );
});

Deno.test("DispatchSecretLoads: a missing, forged or control credential reads nothing", async () => {
  const f = fixture();
  const control = f.sessions.issue(f.dispatch.workerName).credential;
  for (const credential of [null, "forged", control]) {
    const response = await load(
      f,
      request({ references: [IN_BAG] }, credential),
    );
    assertEquals(response.status, 401);
    assertEquals(response.headers.get("cache-control"), "no-store");
    await response.body?.cancel();
  }
  assertEquals(f.reads, []);
});

Deno.test("DispatchSecretLoads: a revoked or expired credential reads nothing", async () => {
  let now = 0;
  const sessions = new SessionCredentialService({
    now: () => now,
    setInterval: () => 0,
    clearInterval: () => {},
  });
  const f = fixture();
  const loads = new DispatchSecretLoads({
    sessions,
    dispatches: f.dispatches,
    vault: () => Promise.reject(new Error("not reached")),
    repoFor: () => ({} as UnifiedDataRepository),
  });
  const expiring = sessions.issueForDispatch("worker-1", f.dispatch.dispatchId);
  now = DEFAULT_SESSION_TTL_MS + 1;
  const revoked = sessions.issueForDispatch("worker-1", f.dispatch.dispatchId);
  sessions.revokeDispatch("worker-1", f.dispatch.dispatchId);
  for (const credential of [expiring.credential, revoked.credential]) {
    const response = await loads.handle(
      request({ references: [IN_BAG] }, credential),
      "127.0.0.1",
      (_caller, fn) => fn(),
    );
    assertEquals(response.status, 401);
    await response.body?.cancel();
  }
});

Deno.test("DispatchSecretLoads: a credential whose dispatch is gone gets access_ended", async () => {
  const f = fixture();
  f.dispatches.unregister(f.dispatch.workerName, f.dispatch.dispatchId);
  const refused = await refusalOf(
    await load(f, request({ references: [IN_BAG] }, f.credential)),
  );
  assertEquals([refused.status, refused.code], [410, "access_ended"]);
  assertEquals(f.reads, []);
});

Deno.test("DispatchSecretLoads: an out-of-bag reference refuses the whole request, naming it", async () => {
  const f = fixture();
  const outside = { vaultName: "default", key: "other-key" };
  const response = await load(
    f,
    request({ references: [IN_BAG, outside] }, f.credential),
  );
  assertEquals(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assertEquals(response.status, 403);
  assertEquals(body.code, "not_in_dispatch");
  assertEquals(body.reference, outside);
  assertEquals(f.reads, []);
});

Deno.test("DispatchSecretLoads: a dispatch with no bag admits nothing", async () => {
  const f = fixture({ bag: [] });
  const refused = await refusalOf(
    await load(f, request({ references: [IN_BAG] }, f.credential)),
  );
  assertEquals([refused.status, refused.code], [403, "not_in_dispatch"]);
});

Deno.test("DispatchSecretLoads: a reserved secret is refused even when the bag holds it", async () => {
  const reserved = { vaultName: "default", key: "server-token-abc" };
  const f = fixture({ bag: [reserved] });
  const refused = await refusalOf(
    await load(f, request({ references: [reserved] }, f.credential)),
  );
  assertEquals([refused.status, refused.code], [403, "reserved_secret"]);
  assertEquals(f.reads, []);
});

Deno.test("DispatchSecretLoads: an oversized body is refused before any read", async () => {
  const f = fixture();
  const oversized = "x".repeat(MAX_DISPATCH_SECRET_LOAD_BODY_BYTES + 1);
  // Declared by its length, and streamed with no length at all.
  const streamed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(oversized));
      controller.close();
    },
  });
  for (const raw of [oversized, streamed]) {
    const refused = await refusalOf(
      await load(f, request(null, f.credential, { raw })),
    );
    assertEquals([refused.status, refused.code], [413, "request_too_large"]);
  }
  assertEquals(f.reads, []);
});

Deno.test("DispatchSecretLoads: a malformed body or method is refused", async () => {
  const f = fixture();
  for (
    const req of [
      request(null, f.credential, { raw: "{not json" }),
      request({ references: [] }, f.credential),
      request({ references: [{ ...IN_BAG, extra: 1 }] }, f.credential),
      request({ references: [IN_BAG], more: true }, f.credential),
    ]
  ) {
    const refused = await refusalOf(await load(f, req));
    assertEquals([refused.status, refused.code], [400, "malformed_request"]);
  }
  const get = await load(f, request(null, f.credential, { method: "GET" }));
  assertEquals(get.status, 405);
  await get.body?.cancel();
  assertEquals(f.reads, []);
});

Deno.test("DispatchSecretLoads: a repeated reference is read once and returned once", async () => {
  const f = fixture();
  const response = await load(
    f,
    request({ references: [IN_BAG, IN_BAG] }, f.credential),
  );
  assertEquals((await response.json()).values.length, 1);
  assertEquals(f.reads, ["default/db-password"]);
});

Deno.test("DispatchSecretLoads: the read is held to the run's vault access, and unscoped only when the run is", async () => {
  const outsideScope = { vaultName: "erp", key: "db-password" };
  const scoped = fixture({
    bag: [outsideScope],
    vaultAccess: RunVaultAccess.create({ allowedVaults: ["default"] }),
  });
  const refused = await refusalOf(
    await load(
      scoped,
      request({ references: [outsideScope] }, scoped.credential),
    ),
  );
  assertEquals([refused.status, refused.code], [403, "vault_access_denied"]);

  const unscoped = fixture({ bag: [outsideScope] });
  const response = await load(
    unscoped,
    request({ references: [outsideScope] }, unscoped.credential),
  );
  assertEquals(response.status, 200);
  await response.body?.cancel();
});

Deno.test("DispatchSecretLoads: a vault error names the reference and never echoes the provider's message", async () => {
  const f = fixture({ vaultError: new Error(`backend said ${SECRET}`) });
  const refused = await refusalOf(
    await load(f, request({ references: [IN_BAG] }, f.credential)),
  );
  assertEquals([refused.status, refused.code], [500, "vault_error"]);
  assertFalse(refused.text.includes(SECRET));
});

for (
  const [ending, end] of [
    [
      "the credential is revoked",
      (f: Fixture) =>
        f.sessions.revokeDispatch(f.dispatch.workerName, f.dispatch.dispatchId),
    ],
    [
      "the dispatch is unregistered",
      (f: Fixture) =>
        f.dispatches.unregister(f.dispatch.workerName, f.dispatch.dispatchId),
    ],
    [
      "the worker's credentials are all revoked",
      (f: Fixture) => f.sessions.revokeAllForWorker(f.dispatch.workerName),
    ],
  ] as const
) {
  Deno.test(`DispatchSecretLoads: a read in flight gets no value when ${ending}`, async () => {
    const f = fixture({ gated: true });
    const pending = load(f, request({ references: [IN_BAG] }, f.credential));
    await f.gate!.started;
    end(f);
    f.gate!.release();
    const response = await pending;
    const text = await response.text();
    assertEquals(response.status, 410);
    assertEquals(JSON.parse(text).code, "access_ended");
    assertFalse(text.includes(SECRET));
    // Nothing was delivered, so the dispatch's redactor learned nothing.
    assertEquals(f.dispatch.redactor, undefined);
  });
}

Deno.test("DispatchSecretLoads: a reference held by a tagged field of the dispatch's own resource loads by its claim", async () => {
  const content = { password: "${{ vault.get('default', 'claimed-key') }}" };
  const bytes = new TextEncoder().encode(JSON.stringify(content));
  const checksum = await computeChecksum(bytes);
  const repo = {
    findByName: (
      _t: ModelType,
      modelId: string,
      name: string,
      version?: number,
    ) =>
      Promise.resolve(
        name === "state-main" && version === 3
          ? {
            name,
            version,
            checksum,
            tags: {
              [RECORD_KIND_TAG]: "resource",
              [SENSITIVE_FIELDS_TAG]: JSON.stringify(["password"]),
              [SENSITIVE_FIELDS_VERSION_TAG]: SENSITIVE_FIELDS_VERSION,
            },
            ownerDefinition: { ownerType: "model-method", ownerRef: modelId },
          }
          : null,
      ),
    getContent: () => Promise.resolve(bytes),
  } as unknown as UnifiedDataRepository;
  const f = fixture({ bag: [], repo });
  const claimed = {
    vaultName: "default",
    key: "claimed-key",
    resource: { name: "state-main", version: 3 },
  };
  const response = await load(
    f,
    request({ references: [claimed] }, f.credential),
  );
  assertEquals(response.status, 200);
  assertEquals(
    (await response.json()).values[0].value,
    `${SECRET}:claimed-key`,
  );

  const wrongVersion = {
    ...claimed,
    resource: { name: "state-main", version: 2 },
  };
  const refused = await refusalOf(
    await load(f, request({ references: [wrongVersion] }, f.credential)),
  );
  assertEquals([refused.status, refused.code], [403, "resource_claim_refused"]);
});

Deno.test("DispatchSecretLoads: every request is audited with metadata only", async () => {
  const f = fixture();
  const ok = await load(f, request({ references: [IN_BAG] }, f.credential));
  await ok.body?.cancel();
  const denied = await load(
    f,
    request(
      { references: [{ vaultName: "default", key: "nope" }] },
      f.credential,
    ),
  );
  await denied.body?.cancel();
  const anonymous = await load(f, request({ references: [IN_BAG] }, "forged"));
  await anonymous.body?.cancel();
  // A wrong method with a valid credential still names its worker.
  const get = await load(f, request(null, f.credential, { method: "GET" }));
  await get.body?.cancel();

  assertEquals(
    f.events.map((e) => [e.category, e.action, e.outcome, e.detail]),
    [
      ["secrets", "worker.secrets.load", "success", "loaded; 1 references"],
      [
        "secrets",
        "worker.secrets.load",
        "denied",
        "not_in_dispatch; 1 references",
      ],
      [
        "secrets",
        "worker.secrets.load",
        "denied",
        "unauthenticated; 0 references",
      ],
      [
        "secrets",
        "worker.secrets.load",
        "failure",
        "malformed_request; 0 references",
      ],
    ],
  );
  assertEquals(DISPATCH_SECRET_LOAD_AUDIT_ACTION, "worker.secrets.load");
  assertEquals(f.events[0].resourceName, f.dispatch.dispatchId);
  assertEquals(f.events[0].principalId, "worker-1");
  assertEquals(f.events[2].principalKind, "anonymous");
  assertEquals(
    [f.events[3].principalKind, f.events[3].principalId],
    ["worker", "worker-1"],
  );
  assertFalse(JSON.stringify(f.events).includes(SECRET));
});

Deno.test("DispatchSecretLoads: a worker reusing a denied request id cannot hide its loads from audit", async () => {
  const f = fixture();
  const events: AuditEvent[] = [];
  const emitter = new AuditEmitter([{
    name: "capture",
    durable: true,
    write: (batch: readonly AuditEvent[]) => {
      events.push(...batch);
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }]);
  const loads = new DispatchSecretLoads({
    sessions: f.sessions,
    dispatches: f.dispatches,
    vault: () =>
      Promise.resolve({ get: () => Promise.resolve(SECRET) } as never),
    repoFor: () => ({} as UnifiedDataRepository),
    audit: () => ({ emitter, instanceId: "serve-1" }),
  });
  const reused = { "x-swamp-request-id": crypto.randomUUID() };
  for (
    const references of [[{ vaultName: "default", key: "nope" }], [IN_BAG]]
  ) {
    const response = await loads.handle(
      request({ references }, f.credential, { headers: reused }),
      "127.0.0.1",
      (_caller, fn) => fn(),
    );
    await response.body?.cancel();
  }
  await emitter.flush();
  assertEquals(events.map((e) => e.outcome), ["denied", "success"]);
  assert(events.every((e) => e.requestId !== reused["x-swamp-request-id"]));
  assert(events[0].requestId !== events[1].requestId);
  await emitter.close();
});

Deno.test("DispatchSecretLoads: in fail-secure mode, with audit unable to record, the route refuses before any read", async () => {
  const f = fixture();
  let refusing = true;
  const loads = new DispatchSecretLoads({
    sessions: f.sessions,
    dispatches: f.dispatches,
    vault: () => Promise.reject(new Error("not reached")),
    repoFor: () => ({} as UnifiedDataRepository),
    audit: () => ({
      emitter: {
        emit: (e: AuditEvent) => f.events.push(e),
      } as unknown as AuditEmitter,
      instanceId: "serve-1",
      refuseRequests: () => refusing,
    }),
  });
  const handle = () =>
    loads.handle(
      request({ references: [IN_BAG] }, f.credential),
      "127.0.0.1",
      (_caller, fn) => fn(),
    );
  const refused = await refusalOf(await handle());
  assertEquals([refused.status, refused.code], [503, "audit_unavailable"]);
  assertEquals(f.events.map((e) => e.outcome), ["failure"]);
  // Once audit records again, so does the route (here, up to the vault).
  refusing = false;
  const next = await refusalOf(await handle());
  assertEquals(next.code, "internal_error");
});

Deno.test("DispatchSecretLoads: a request claiming too many distinct resources is refused before any lookup", async () => {
  const f = fixture({
    bag: [],
    repo: {
      findByName: () => Promise.reject(new Error("not reached")),
    } as unknown as UnifiedDataRepository,
  });
  const claims = Array.from(
    { length: MAX_DISPATCH_SECRET_CLAIMS + 1 },
    (_, version) => ({
      vaultName: "default",
      key: "k",
      resource: { name: "state-main", version: version + 1 },
    }),
  );
  const refused = await refusalOf(
    await load(f, request({ references: claims }, f.credential)),
  );
  assertEquals([refused.status, refused.code], [400, "malformed_request"]);
  // Claims of one resource count once, so this request passes the cap and
  // reaches the (failing) lookup.
  const sameResource = claims.map((c) => ({
    ...c,
    resource: { name: "state-main", version: 1 },
  }));
  const repeated = await refusalOf(
    await load(f, request({ references: sameResource }, f.credential)),
  );
  assertEquals(repeated.code, "internal_error");
});
