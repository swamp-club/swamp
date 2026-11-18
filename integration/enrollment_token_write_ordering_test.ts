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

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { createResourceWriter } from "../src/domain/models/data_writer.ts";
import {
  ENROLLMENT_TOKEN_MODEL_TYPE,
  type EnrollmentToken,
  enrollmentTokenModel,
} from "../src/domain/models/worker/enrollment_token_model.ts";
import { setEnrollmentTokenWriteOrdering } from "../src/domain/models/worker/enrollment_token_write_ordering.ts";
import {
  ControlPlaneVaultProvider,
  TOKEN_SECRETS_VAULT_NAME,
} from "../src/domain/vaults/control_plane_vault_provider.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  repoUnitOfWorkFactory,
  runInRootUnitOfWork,
} from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { collect } from "../src/libswamp/testing.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import {
  createModelMethodRunDeps,
  executeWorkflowWithLocks,
} from "../src/serve/deps.ts";
import {
  handleWorkerTokenCreate,
  handleWorkerTokenRevoke,
  handleWorkerTokenRotate,
} from "../src/serve/handlers/admin_handlers.ts";
import { RpcChannel } from "../src/domain/remote/rpc_channel.ts";
import {
  type EnrollResult,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
} from "../src/domain/remote/protocol.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { createSyncGate } from "../src/serve/sync_gate.ts";
import { WorkerGateway } from "../src/serve/worker_gateway.ts";
import {
  initializeV3Datastore,
  openV3Datastore,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";

await initializeLogging({});

const TOKEN = "fleet";

/** the context serve's model method handler runs with */
function serveLibContext(repoContext: RepositoryContext) {
  return createLibSwampContext({
    openUnitOfWork: repoUnitOfWorkFactory(repoContext),
  });
}

type Instance = Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;

interface Fixture {
  dir: string;
  instance: Instance;
  repoContext: RepositoryContext;
  gateway: WorkerGateway;
  /** how many token runs asked the gateway tail for a turn */
  turnsRequested: () => number;
  plaintext: string;
  /** the token record as a fresh checkout of the datastore reads it */
  durableToken: () => Promise<EnrollmentToken>;
}

async function initRepo(repoDir: string, datastorePath?: string) {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  if (datastorePath === undefined) return;
  const markerPath = join(repoDir, ".swamp.yaml");
  const marker = await Deno.readTextFile(markerPath);
  await Deno.writeTextFile(
    markerPath,
    marker.trimEnd() + "\n" + [
      "datastore:",
      "  type: filesystem",
      `  path: ${JSON.stringify(datastorePath)}`,
      "  format: 3",
    ].join("\n") + "\n",
  );
}

async function readCheckoutToken(
  repoDir: string,
  modelId: string,
): Promise<EnrollmentToken> {
  const nameDir = join(
    swampPath(repoDir),
    "data",
    ENROLLMENT_TOKEN_MODEL_TYPE.toDirectoryPath(),
    modelId,
    "token-main",
  );
  const latest = (await Deno.readTextFile(join(nameDir, "latest"))).trim();
  return JSON.parse(
    await Deno.readTextFile(join(nameDir, latest, "raw")),
  ) as EnrollmentToken;
}

async function withFixture(
  fn: (f: Fixture) => Promise<void>,
  options: { v3?: boolean } = {},
): Promise<void> {
  // the macOS temp dir is a symlink, and the v3 checkout resolves through it
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-token-ordering-" }),
  );
  let instance: Instance | undefined;
  let gateway: WorkerGateway | undefined;
  try {
    const repoDir = options.v3 ? join(dir, "a") : dir;
    const datastorePath = options.v3 ? join(dir, "datastore") : undefined;
    if (datastorePath !== undefined) {
      await initializeV3Datastore(datastorePath, "test");
      await initRepo(join(dir, "b"), datastorePath);
    }
    await initRepo(repoDir, datastorePath);
    instance = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: "json",
    });
    const repoContext = instance.repoContext;

    const provider = new ControlPlaneVaultProvider(
      new FileSystemControlPlaneStore(swampPath(repoDir)),
    );
    await provider.initialize();
    VaultService.registerGlobalProvider(
      TOKEN_SECRETS_VAULT_NAME,
      "control_plane",
      provider,
    );

    const live = new WorkerGateway({
      repoDir,
      repoContext,
      capabilityService: { registerHandlers: () => {} },
      readTokenSecret: async (vaultName, secretKey) =>
        await (await VaultService.fromRepository(repoDir)).get(
          vaultName,
          secretKey,
        ),
    });
    gateway = live;
    let turns = 0;
    setEnrollmentTokenWriteOrdering((write) => {
      turns++;
      return live.orderTokenMethodRun(write);
    });

    const plaintext = await mintToken(repoDir, repoContext, live);
    const durableToken = async (): Promise<EnrollmentToken> => {
      const definition = await repoContext.definitionRepo.findByName(
        ENROLLMENT_TOKEN_MODEL_TYPE,
        TOKEN,
      );
      assert(definition !== null);
      if (datastorePath === undefined) {
        return await readCheckoutToken(repoDir, definition.id);
      }
      const checkout = openV3Datastore({
        repoDir: join(dir, "b"),
        datastorePath,
      });
      try {
        await checkout.catchUp();
      } finally {
        await checkout.close();
      }
      return await readCheckoutToken(join(dir, "b"), definition.id);
    };
    await fn({
      dir: repoDir,
      instance,
      repoContext,
      gateway: live,
      turnsRequested: () => turns,
      plaintext,
      durableToken,
    });
  } finally {
    setEnrollmentTokenWriteOrdering(null);
    if (gateway !== undefined) {
      await gateway.settled();
      gateway.dispose();
    }
    VaultService.unregisterGlobalProvider(TOKEN_SECRETS_VAULT_NAME);
    instance?.repoContext.catalogStore.close();
    if (options.v3) {
      await closeV3Datastores();
      await flushDatastoreSync();
    }
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function mockSocket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(data),
    sent,
    close() {},
  } as unknown as WebSocket & { sent: string[] };
}

function connectionContext(
  dir: string,
  repoContext: RepositoryContext,
  gateway: WorkerGateway,
): ConnectionContext {
  return {
    repoDir: dir,
    repoContext,
    datastoreConfig: { type: "filesystem" },
    datastoreResolver: {},
    authConfig: { mode: "none" },
    workerGateway: gateway,
  } as unknown as ConnectionContext;
}

async function mintToken(
  dir: string,
  repoContext: RepositoryContext,
  gateway: WorkerGateway,
): Promise<string> {
  const socket = mockSocket();
  await handleWorkerTokenCreate(
    socket,
    connectionContext(dir, repoContext, gateway),
    "req-create",
    { name: TOKEN, durationMs: 60 * 60_000, maxEnrollments: 10 },
    new AbortController(),
    null,
  );
  const response = JSON.parse(socket.sent[0]);
  assertEquals(response.type, "worker.token.create", socket.sent[0]);
  return response.payload.data.token as string;
}

async function readToken(f: Fixture): Promise<EnrollmentToken> {
  const record = (await f.gateway.readTokenRecords()).get(TOKEN);
  assert(record !== undefined, "the token record should be readable");
  return record;
}

async function writeToken(f: Fixture, record: EnrollmentToken): Promise<void> {
  const definition = await f.repoContext.definitionRepo.findByName(
    ENROLLMENT_TOKEN_MODEL_TYPE,
    TOKEN,
  );
  assert(definition !== null);
  await runInRootUnitOfWork(f.repoContext, { flush: undefined }, async () => {
    const { writeResource } = createResourceWriter(
      f.repoContext.unifiedDataRepo,
      ENROLLMENT_TOKEN_MODEL_TYPE,
      definition.id,
      enrollmentTokenModel.resources!,
      undefined,
      undefined,
      definition.tags,
      undefined,
      definition.name,
    );
    await writeResource("token", "token-main", record);
  });
}

/**
 * plays a redeem on the gateway tail: it reads the record, waits until the
 * rotate under test asked for a turn or wrote, then writes what it read plus a
 * binding; rotate must land after it or be lost
 */
async function redeemAround(
  f: Fixture,
  rotate: () => Promise<void>,
): Promise<EnrollmentToken> {
  const before = await readToken(f);
  // minting already took turns, so only a rise past this counts as the rotate's
  const baseline = f.turnsRequested();
  let rotateDone = false;
  const redeem = f.gateway.serializeTokenWrite(async () => {
    const read = await readToken(f);
    await waitFor(
      async () =>
        f.turnsRequested() > baseline ||
        (await readToken(f)).createdAt !== read.createdAt,
      "the rotate to ask for a turn or to write",
    );
    await writeToken(f, {
      ...read,
      state: "enrolled",
      bindings: [
        ...read.bindings,
        { machineId: "late-machine", enrolledAt: new Date().toISOString() },
      ],
    });
  });
  const rotation = rotate().finally(() => {
    rotateDone = true;
  });
  await Promise.all([redeem, rotation]);
  assert(rotateDone);
  return before;
}

function assertRotationKept(before: EnrollmentToken, after: EnrollmentToken) {
  assertNotEquals(after.createdAt, before.createdAt, "the rotation was lost");
  assertNotEquals(after.secretKey, before.secretKey);
  assertEquals(after.predecessor?.createdAt, before.createdAt);
  assertEquals(
    after.bindings.map((b) => b.machineId),
    ["late-machine"],
    "the redeem's binding was lost",
  );
}

Deno.test("enrollment token write ordering: a rotate run through serve's model method path lands after a redeem in progress", async () => {
  await withFixture(async (f) => {
    const before = await redeemAround(f, async () => {
      const deps = await createModelMethodRunDeps(f.dir, f.repoContext);
      const events = await collect(
        modelMethodRun(serveLibContext(f.repoContext), deps, {
          modelIdOrName: TOKEN,
          methodName: "rotate",
          inputs: {},
          lastEvaluated: false,
        }),
      );
      const error = events.find((event) => event.kind === "error");
      assertEquals(error, undefined, JSON.stringify(error));
    });
    assertRotationKept(before, await readToken(f));
  });
});

Deno.test("enrollment token write ordering: a rotate run as a workflow step on serve lands after a redeem in progress", async () => {
  await withFixture(async (f) => {
    await f.repoContext.workflowRepo.save(Workflow.create({
      name: "rotate-fleet",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "rotate",
              task: StepTask.modelMethod(TOKEN, "rotate"),
            }),
          ],
        }),
      ],
    }));
    const before = await redeemAround(f, async () => {
      let status: string | undefined;
      let failure: string | undefined;
      await executeWorkflowWithLocks(
        f.dir,
        f.repoContext,
        f.instance.datastoreConfig,
        { workflowIdOrName: "rotate-fleet", inputs: {} },
        new AbortController().signal,
        (event: WorkflowRunEvent) => {
          if (event.kind === "completed") status = event.run.status;
          if (event.kind === "error") failure = event.error.message;
        },
        f.instance.syncService,
        undefined,
        { syncGate: createSyncGate() },
      );
      assertEquals(failure, undefined);
      assertEquals(status, "succeeded");
    });
    assertRotationKept(before, await readToken(f));
  });
});

function connectWorker(gateway: WorkerGateway): RpcChannel {
  const worker: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => attached.feed(data)),
  });
  const attached = gateway.attachTransport({
    send: (data) => void Promise.resolve().then(() => worker.handleRaw(data)),
  }, () => {
    attached.closed();
    worker.close("control socket closed");
  });
  return worker;
}

Deno.test("enrollment token write ordering: the gateway's own enroll, rotate and revoke still complete with the ordering registered", async () => {
  await withFixture(async (f) => {
    const ctx = connectionContext(f.dir, f.repoContext, f.gateway);
    const worker = connectWorker(f.gateway);
    const baseline = f.turnsRequested();
    const enrolled = await worker.call<EnrollResult>(RemoteMethod.enroll, {
      token: f.plaintext,
      instanceUuid: "uuid-1",
      machineId: "machine-1",
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      swampVersion: "1.0.0",
      platform: "linux",
      arch: "x86_64",
      labels: {},
    });
    assertEquals(typeof enrolled.sessionCredential, "string");

    const rotateSocket = mockSocket();
    await handleWorkerTokenRotate(
      rotateSocket,
      ctx,
      "req-rotate",
      { name: TOKEN },
      new AbortController(),
      null,
    );
    assertEquals(
      JSON.parse(rotateSocket.sent[0]).type,
      "worker.token.rotate",
      rotateSocket.sent[0],
    );

    const revokeSocket = mockSocket();
    await handleWorkerTokenRevoke(
      revokeSocket,
      ctx,
      "req-revoke",
      { name: TOKEN },
      new AbortController(),
      null,
    );
    assertEquals(
      JSON.parse(revokeSocket.sent[0]).type,
      "worker.token.revoke",
      revokeSocket.sent[0],
    );
    assertEquals((await readToken(f)).state, "revoked");
    assert(f.turnsRequested() > baseline);
    worker.close("test done");
  });
});

/**
 * the rotate's run stays open after its turn, as a serve run does until its
 * last step; an enrollment then commits in its own turn, and the rotate's run
 * ends last
 */
async function enrollAfterRotate(
  f: Fixture,
  runRotate: (afterRotate: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const rotated = Promise.withResolvers<void>();
  const enrolled = Promise.withResolvers<void>();
  const rotation = runRotate(async () => {
    rotated.resolve();
    await enrolled.promise;
  });
  await Promise.race([rotated.promise, rotation]);
  await f.gateway.serializeTokenWrite(async () => {
    const read = await readToken(f);
    await writeToken(f, {
      ...read,
      state: "enrolled",
      bindings: [
        ...read.bindings,
        { machineId: "late-machine", enrolledAt: new Date().toISOString() },
      ],
    });
  });
  enrolled.resolve();
  await rotation;
}

function assertEnrollmentKept(rotatedFrom: string, after: EnrollmentToken) {
  assertNotEquals(after.createdAt, rotatedFrom, "the rotation was lost");
  assertEquals(
    after.bindings.map((b) => b.machineId),
    ["late-machine"],
    "the enrollment after the rotation was lost",
  );
}

Deno.test("enrollment token write ordering: on a v3 datastore an enrollment after a rotate in an open serve run stays durable", async () => {
  await withFixture(async (f) => {
    const mint = (await readToken(f)).createdAt;
    await enrollAfterRotate(f, async (afterRotate) => {
      const deps = await createModelMethodRunDeps(f.dir, f.repoContext);
      await runInRootUnitOfWork(
        f.repoContext,
        { flush: undefined },
        async () => {
          const events = await collect(
            modelMethodRun(serveLibContext(f.repoContext), deps, {
              modelIdOrName: TOKEN,
              methodName: "rotate",
              inputs: {},
              lastEvaluated: false,
            }),
          );
          const error = events.find((event) => event.kind === "error");
          assertEquals(error, undefined, JSON.stringify(error));
          await afterRotate();
        },
      );
    });
    assertEnrollmentKept(mint, await readToken(f));
    assertEnrollmentKept(mint, await f.durableToken());
  }, { v3: true });
});
