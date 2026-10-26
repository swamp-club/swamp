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
 * Content-level authorisation of forwarded commits (swamp-club#3922), end
 * to end over serve's datastore API on a real v3 repository.
 *
 * Parity tests send one edit over the WebSocket handler and as a forwarded
 * commit, and expect the same answer from both. The rest pin what only a
 * forwarded commit could try: content that claims another aggregate's
 * identity, run records that carry authority or executable state, data
 * that names secrets, and evaluations serve would run.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../src/domain/datastore_v3/partition_key.ts";
import { UserError } from "../src/domain/errors.ts";
import { v3EvaluationTrust } from "../src/infrastructure/datastore_v3/trusted_evaluations.ts";
import {
  errorFrame,
  grant,
  saveGatedWorkflow,
  sendRequest,
} from "./serve_request_harness.ts";
import {
  judgeRunRecord,
  type StepKind,
} from "../src/domain/datastore_v3/content_bindings.ts";
import {
  type WorkflowRunData,
  WorkflowRunSchema,
} from "../src/domain/workflows/workflow_run.ts";
import type { Workflow } from "../src/domain/workflows/workflow.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { Workflow as WorkflowEntity } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Data } from "../src/domain/data/data.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { localEncryptionSecretsDirFor } from "../src/domain/vaults/local_encryption_vault_provider.ts";
import { UploadLedger } from "../src/infrastructure/datastore_v3/upload_ledger.ts";
import { ForwardedContentAuthority } from "../src/serve/forwarded_content_authorization.ts";
import { waitFor } from "@swamp-club/swamp-testing";
import { join } from "@std/path";
import {
  blobSaveOps,
  commitBody,
  member,
  post,
  type Server,
  sha256Hex,
  withServer,
} from "./serve_datastore_api_harness.ts";

const encoder = new TextEncoder();

/** A YAML file's bytes, as the repositories write one. */
function yaml(value: unknown): Uint8Array {
  return encoder.encode(stringifyYaml(JSON.parse(JSON.stringify(value))));
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Forwards one commit of `ops` onto `partition`'s head. */
async function forward(
  server: Server,
  partition: PartitionKey,
  ops: unknown[],
): Promise<{ status: number; json: Record<string, unknown> }> {
  const head = await server.v3.commitStore.head(server.v3.namespace, partition);
  return await post(
    `${server.url}/partitions/${
      encodeURIComponent(partition.toString())
    }/commits`,
    "alice-token",
    commitBody({
      expectedSeq: head.seq,
      txnId: crypto.randomUUID(),
      ops,
      chunks: [],
    }),
  );
}

/** A put of `bytes` inline. */
function put(intent: unknown, key: string, bytes: Uint8Array) {
  return { kind: "put", intent, key, inline: base64(bytes) };
}

function behaviorPartition(name: string): PartitionKey {
  return partitionOf({ kind: "config", definitionKind: "model", name });
}

/** The forwarded edit of the server's `web` behavior to `definition`. */
function webEdit(server: Server, definition: Definition) {
  return put(
    { kind: "definition.edit", definition: { kind: "model", name: "web" } },
    `config/models/${server.modelType.normalized}/web.yaml`,
    yaml(definition.toData()),
  );
}

/** `web` as stored, with `change` applied to its data. */
function editedWeb(
  server: Server,
  change: (data: Record<string, unknown>) => void,
): Definition {
  const data = JSON.parse(JSON.stringify(server.model.toData()));
  data.type = server.modelType.normalized;
  change(data);
  return Definition.fromData(data);
}

/** Sends `web`'s edit over the WebSocket handler; true when it is refused. */
async function refusedOverWebSocket(
  server: Server,
  definition: Definition,
): Promise<boolean> {
  const frames = await sendRequest(server.ctx, {
    type: "model.edit",
    id: crypto.randomUUID(),
    payload: {
      modelIdOrName: "web",
      content: stringifyYaml(JSON.parse(JSON.stringify(definition.toData()))),
    },
  });
  return errorFrame(frames) !== undefined;
}

const MANAGED = { managedConfig: true };

const writeModels = grant({
  actions: ["read", "write", "run"],
  resource: { kind: "model", pattern: "*" },
});

/**
 * The answer both paths give one edit, run against a fresh server each, so
 * one landing cannot change the other's.
 */
async function parity(
  grants: Grant[],
  change: (server: Server) => Definition,
): Promise<{ webSocket: boolean; forwarded: boolean }> {
  let webSocket = false;
  let forwarded = false;
  // Under managed config, where definitions are datastore records, as a
  // team's are.
  await withServer(
    grants,
    async (server) => {
      webSocket = await refusedOverWebSocket(server, change(server));
    },
    undefined,
    MANAGED,
  );
  await withServer(
    grants,
    async (server) => {
      const answer = await forward(server, behaviorPartition("web"), [
        webEdit(server, change(server)),
      ]);
      forwarded = answer.status !== 200;
    },
    undefined,
    MANAGED,
  );
  return { webSocket, forwarded };
}

Deno.test({
  name:
    "forwarded content: a retag needs tag, as model.edit decides it, and passes with it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const retag = (server: Server) =>
      editedWeb(server, (data) => {
        data.tags = { env: "prod" };
      });
    // Write implies tag; a deny on tag takes it away.
    const noTag = grant({
      effect: "deny",
      actions: ["tag"],
      resource: { kind: "model", pattern: "*" },
    });
    assertEquals(await parity([writeModels, noTag], retag), {
      webSocket: true,
      forwarded: true,
    });
    assertEquals(await parity([writeModels], retag), {
      webSocket: false,
      forwarded: false,
    });
  },
});

Deno.test({
  name:
    "forwarded content: an added expression reading data the writer may not read is refused on both paths",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const reads = (server: Server) =>
      editedWeb(server, (data) => {
        data.globalArguments = {
          secret: '${{ data.latest("vault-keeper", "token").attributes.v }}',
        };
      });
    const noData = [writeModels];
    assertEquals(await parity(noData, reads), {
      webSocket: true,
      forwarded: true,
    });
    const readsData = [
      writeModels,
      grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
    ];
    assertEquals(await parity(readsData, reads), {
      webSocket: false,
      forwarded: false,
    });
  },
});

Deno.test({
  name:
    "forwarded content: a behavior's content must declare the identity its intent and key name",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(
      member(),
      async (server) => {
        // Another behavior's name, in web's file.
        const renamed = editedWeb(server, (data) => {
          data.name = "prod-db";
        });
        const named = await forward(server, behaviorPartition("web"), [
          webEdit(server, renamed),
        ]);
        assertEquals(named.status, 403, JSON.stringify(named.json));
        assertEquals(named.json.reason, "content-refused");
        // Another id: an edit never changes a definition's id.
        const reid = editedWeb(server, (data) => {
          data.id = crypto.randomUUID();
        });
        const moved = await forward(server, behaviorPartition("web"), [
          webEdit(server, reid),
        ]);
        assertEquals(moved.status, 403, JSON.stringify(moved.json));
        assertEquals(moved.json.reason, "content-refused");
        // The same file declaring its own identity lands.
        const kept = await forward(server, behaviorPartition("web"), [
          webEdit(server, editedWeb(server, () => {})),
        ]);
        assertEquals(kept.status, 200, JSON.stringify(kept.json));
      },
      undefined,
      MANAGED,
    );
  },
});

Deno.test({
  name:
    "forwarded content: a create may not claim an id another behavior holds, nor one its records are still stored under",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(
      member(),
      async (server) => {
        const type = server.modelType.normalized;
        const claim = Definition.create({
          id: server.model.id,
          name: "mine",
          type,
          globalArguments: {},
        });
        const claimed = await forward(server, behaviorPartition("mine"), [
          put(
            {
              kind: "definition.create",
              definition: { kind: "model", name: "mine" },
            },
            `config/models/${type}/mine.yaml`,
            yaml(claim.toData()),
          ),
        ]);
        assertEquals(claimed.status, 403, JSON.stringify(claimed.json));
        assertEquals(claimed.json.reason, "content-refused");
        const fresh = Definition.create({
          name: "mine",
          type,
          globalArguments: {},
        });
        const created = await forward(server, behaviorPartition("mine"), [
          put(
            {
              kind: "definition.create",
              definition: { kind: "model", name: "mine" },
            },
            `config/models/${type}/mine.yaml`,
            yaml(fresh.toData()),
          ),
        ]);
        assertEquals(created.status, 200, JSON.stringify(created.json));
      },
      undefined,
      MANAGED,
    );
  },
});

Deno.test({
  name:
    "forwarded content: a vault's name is a single segment, its key source is serve's, and its config cannot be removed by a non-admin",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const vaultWriter = grant({
      actions: ["read", "write"],
      resource: { kind: "vault", pattern: "*" },
    });
    await withServer(
      [vaultWriter],
      async (server) => {
        const vault = (name: string, config: Record<string, unknown> = {}) => {
          const id = crypto.randomUUID();
          return {
            key: `config/vaults/local_encryption/${id}.yaml`,
            bytes: yaml({
              id,
              name,
              type: "local_encryption",
              config,
              createdAt: "2026-10-26T00:00:00.000Z",
            }),
          };
        };
        const create = (
          name: string,
          file: { key: string; bytes: Uint8Array },
        ) =>
          forward(
            server,
            partitionOf({ kind: "config", definitionKind: "vault", name }),
            [
              put(
                {
                  kind: "definition.create",
                  definition: { kind: "vault", name },
                },
                file.key,
                file.bytes,
              ),
            ],
          );
        const aliased = await create("x/../prod", vault("x/../prod"));
        assertEquals(aliased.status, 403, JSON.stringify(aliased.json));
        const keyed = await create(
          "dev",
          vault("dev", { key_file: "/etc/serve/master.key" }),
        );
        assertEquals(keyed.status, 403, JSON.stringify(keyed.json));
        const dev = vault("dev");
        const plain = await create("dev", dev);
        assertEquals(plain.status, 200, JSON.stringify(plain.json));
        const removed = await forward(
          server,
          partitionOf({ kind: "config", definitionKind: "vault", name: "dev" }),
          [{
            kind: "tombstone",
            intent: {
              kind: "definition.delete",
              definition: { kind: "vault", name: "dev" },
            },
            key: dev.key,
          }],
        );
        assertEquals(removed.status, 403, JSON.stringify(removed.json));
        assertEquals(removed.json.reason, "forbidden");
      },
      undefined,
      MANAGED,
    );
  },
});

const WORKFLOW = "44444444-5555-4666-8777-888888888888";

function runRecord(
  runId: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: runId,
    workflowId: WORKFLOW,
    workflowName: "deploy",
    status: "running",
    tags: {},
    jobs: [],
    ...fields,
  };
}

function forwardRun(server: Server, record: Record<string, unknown>) {
  const runId = String(record.id);
  return forward(
    server,
    partitionOf({ kind: "run", workflowId: WORKFLOW, runId }),
    [
      put(
        { kind: "run.create", run: { workflowId: WORKFLOW, runId } },
        `workflow-runs/${WORKFLOW}/workflow-run-${runId}.yaml`,
        yaml(record),
      ),
    ],
  );
}

const runWorkflows = grant({
  actions: ["read", "run"],
  resource: { kind: "workflow", pattern: "*" },
});

Deno.test({
  name:
    "forwarded content: a run record may not claim a principal, a host log path, or a serve instance",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([runWorkflows], async (server) => {
      const refusedFor = async (fields: Record<string, unknown>) => {
        const answer = await forwardRun(
          server,
          runRecord(crypto.randomUUID(), fields),
        );
        assertEquals(answer.status, 403, JSON.stringify(fields));
        assertEquals(answer.json.reason, "content-refused");
        // A refusal never echoes the caller's value.
        assert(!JSON.stringify(answer.json).includes("/etc/passwd"));
      };
      await refusedFor({
        triggeringPrincipal: {
          kind: "user",
          id: "admin",
          membership: { localGroups: [], idpGroups: [], collectives: [] },
        },
      });
      await refusedFor({ logFile: "/etc/passwd" });
      await refusedFor({ logFile: "../../.swamp/serve.yaml" });
      if (server.ctx.instanceId !== undefined) {
        await refusedFor({ instanceId: server.ctx.instanceId });
      }
      const runId = crypto.randomUUID();
      const landed = await forwardRun(
        server,
        runRecord(runId, {
          logFile: `.swamp/workflow-runs/${WORKFLOW}/workflow-run-${runId}.log`,
          pid: 4242,
        }),
      );
      assertEquals(landed.status, 200, JSON.stringify(landed.json));
    });
  },
});

Deno.test({
  name:
    "forwarded content: approving a gate needs approve, reaching it needs only run",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const started = "2026-10-26T00:00:00.000Z";
    const gateRecord = (runId: string, step: Record<string, unknown>) =>
      runRecord(runId, {
        status: "suspended",
        jobs: [{
          jobName: "main",
          status: "waiting_approval",
          steps: [{ stepName: "gate", startedAt: started, ...step }],
        }],
      });
    // Run implies approve unless approve is denied, as here.
    const runOnly = [
      grant({
        actions: ["read", "run"],
        resource: { kind: "workflow", pattern: "*" },
      }),
      grant({
        effect: "deny",
        actions: ["approve"],
        resource: { kind: "workflow", pattern: "*" },
      }),
    ];
    await withServer(runOnly, async (server) => {
      const runId = crypto.randomUUID();
      const waiting = await forwardRun(
        server,
        gateRecord(runId, { status: "waiting_approval" }),
      );
      assertEquals(waiting.status, 200, JSON.stringify(waiting.json));
      const approve = await forward(
        server,
        partitionOf({ kind: "run", workflowId: WORKFLOW, runId }),
        [
          put(
            { kind: "run.update", run: { workflowId: WORKFLOW, runId } },
            `workflow-runs/${WORKFLOW}/workflow-run-${runId}.yaml`,
            yaml(
              gateRecord(runId, {
                status: "succeeded",
                approvalDecision: {
                  approved: true,
                  decidedBy: "user:caller",
                  decidedAt: started,
                },
              }),
            ),
          ),
        ],
      );
      assertEquals(approve.status, 403, JSON.stringify(approve.json));
      assertEquals(approve.json.reason, "content-refused");
    });
  },
});

Deno.test({
  name:
    "forwarded content: data whose sensitive fields name a secret the caller may not read is refused",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Reads only its own behavior's data: a vault is read as data:<name>
    // too, so a wider data grant would read the vault.
    const runner = [
      writeModels,
      grant({ actions: ["read"], resource: { kind: "data", pattern: "web" } }),
    ];
    await withServer(runner, async (server) => {
      const type = server.modelType.normalized;
      const id = server.model.id;
      const base = `data/${type}/${id}/creds/1`;
      const intent = {
        kind: "data.save",
        model: { type, id },
        name: "creds",
        version: 1,
      };
      const metadata = {
        name: "creds",
        id: crypto.randomUUID(),
        version: 1,
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: {
          type: "resource",
          "_swamp.sensitiveFields": JSON.stringify(["token"]),
          "_swamp.sensitiveFieldsVersion": "1",
        },
        ownerDefinition: { ownerType: "model-method", ownerRef: id },
        createdAt: "2026-10-26T00:00:00.000Z",
      };
      const raw = encoder.encode(
        JSON.stringify({
          token: "${{ vault.get('prod', 'payments-api-key') }}",
        }),
      );
      const answer = await forward(
        server,
        partitionOf({ kind: "model", type: server.modelType, id }),
        [
          put(intent, `${base}/raw`, raw),
          put(intent, `${base}/metadata.yaml`, yaml(metadata)),
          { kind: "data-version", key: `${base}/metadata.yaml`, metadata },
        ],
      );
      assertEquals(answer.status, 403, JSON.stringify(answer.json));
      assertEquals(answer.json.reason, "content-refused");
    });
  },
});

Deno.test({
  name:
    "forwarded content: a data removal may only lower a latest marker, never write a version's bytes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dataWriter = [
      ...member(),
      grant({ actions: ["write"], resource: { kind: "data", pattern: "*" } }),
    ];
    await withServer(dataWriter, async (server) => {
      const type = server.modelType.normalized;
      const id = server.model.id;
      const answer = await forward(
        server,
        partitionOf({ kind: "model", type: server.modelType, id }),
        [
          put(
            {
              kind: "data.delete",
              model: { type, id },
              name: "vpc",
              version: 1,
            },
            `data/${type}/${id}/vpc/1/raw`,
            encoder.encode("chosen bytes"),
          ),
        ],
      );
      assertEquals(answer.status, 403, JSON.stringify(answer.json));
      assertEquals(answer.json.reason, "content-refused");
    });
  },
});

Deno.test({
  name:
    "forwarded content: serve does not run an evaluation a forwarded commit wrote",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(member(), async (server) => {
      const type = server.modelType;
      const evaluated = Definition.fromData({
        ...JSON.parse(JSON.stringify(server.model.toData())),
        type: type.normalized,
        globalArguments: { region: "attacker-chosen" },
      });
      const answer = await forward(
        server,
        partitionOf({ kind: "model", type, id: server.model.id }),
        [
          put(
            {
              kind: "evaluated-definition.save",
              model: { type: type.normalized, id: server.model.id },
            },
            `definitions-evaluated/${type.normalized}/web.yaml`,
            yaml(evaluated.toData()),
          ),
        ],
      );
      assertEquals(answer.status, 200, JSON.stringify(answer.json));
      const trust = v3EvaluationTrust(server.v3, server.ctx.repoContext);
      await server.v3.readModel.catchUp(new AbortController().signal);
      await assertRejects(
        () => trust.definition(type, "web"),
        UserError,
        "not made on this server",
      );
    });
  },
});

/** What the stored workflow says a run's step is. */
function kindIn(workflow: Workflow) {
  return (jobName: string, step: { stepName: string }): StepKind => {
    const defined = workflow.jobs.find((job) => job.name === jobName)?.steps
      .find((s) => s.name === step.stepName);
    if (defined === undefined) return "unknown";
    switch (defined.task.data.type) {
      case "manual_approval":
        return "approval";
      case "wait_for_signal":
        return "signal";
      default:
        return "other";
    }
  };
}

Deno.test({
  name:
    "forwarded content: every run record a real gated run writes, through suspend, approve and reject, is judged as its own transitions need",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const admin = grant({
      actions: ["admin"],
      resource: { kind: "access", pattern: "*" },
    });
    await withServer(
      [admin],
      async (server) => {
        const saves: WorkflowRunData[] = [];
        const runRepo = server.ctx.repoContext.workflowRunRepo;
        const previous = runRepo.beforeSave;
        runRepo.beforeSave = async (run) => {
          await previous?.(run);
          const data = JSON.parse(JSON.stringify(run.toPersistedData()));
          saves.push(WorkflowRunSchema.parse(data));
        };
        const workflow = await runInRootUnitOfWork(
          server.ctx.repoContext,
          { flush: undefined },
          () =>
            saveGatedWorkflow(
              { ...server.ctx, modelType: server.modelType },
              "gated",
              "gate",
            ),
        );
        const start = async () => {
          const frames = await sendRequest(server.ctx, {
            type: "workflow.run",
            id: crypto.randomUUID(),
            payload: { workflowIdOrName: "gated" },
          });
          assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
          const last = saves[saves.length - 1];
          return last.id;
        };
        const approved = await start();
        const approve = await sendRequest(server.ctx, {
          type: "workflow.approve",
          id: crypto.randomUUID(),
          payload: {
            workflowIdOrName: "gated",
            stepName: "gate",
            runId: approved,
          },
        });
        assertEquals(errorFrame(approve), undefined, JSON.stringify(approve));
        const rejected = await start();
        const reject = await sendRequest(server.ctx, {
          type: "workflow.reject",
          id: crypto.randomUUID(),
          payload: {
            workflowIdOrName: "gated",
            stepName: "gate",
            runId: rejected,
          },
        });
        assertEquals(errorFrame(reject), undefined, JSON.stringify(reject));

        const byRun = new Map<string, WorkflowRunData[]>();
        for (const save of saves) {
          byRun.set(save.id, [...(byRun.get(save.id) ?? []), save]);
        }
        assert(byRun.size >= 2, "both runs were saved");
        let approvals = 0;
        for (const sequence of byRun.values()) {
          for (const [index, after] of sequence.entries()) {
            const before = index === 0 ? undefined : sequence[index - 1];
            // The records as a client running the workflow itself writes
            // them: with no triggering principal, which only serve records.
            const canonical = (run: WorkflowRunData | undefined) =>
              run && {
                ...run,
                triggeringPrincipal: undefined,
                // A record holds its log as the repository stores it.
                logFile: run.logFile === undefined
                  ? undefined
                  : `.swamp/workflow-runs/${run.workflowId}/workflow-run-${run.id}.log`,
              };
            const judged = judgeRunRecord({
              workflowId: after.workflowId,
              runId: after.id,
              before: canonical(before),
              after: canonical(after)!,
              stepKind: kindIn(workflow),
              definitionSteps: (job) =>
                workflow.jobs.find((j) => j.name === job)?.steps,
              isServeInstance: () => false,
              now: new Date(),
            });
            // Nothing a real run writes is refused.
            assertEquals(judged.refusal, undefined, JSON.stringify(after));
            if (judged.actions.has("approve")) approvals++;
            assertEquals(judged.actions.has("signal"), false);
          }
        }
        // Only the two decisions need approve: starting, reaching the gate and
        // what follows a decision need run.
        assertEquals(approvals, 2);
      },
      undefined,
      MANAGED,
    );
  },
});

/** Saves `workflow` as serve does, in a unit of work. */
async function saveWorkflow(server: Server, workflow: WorkflowEntity) {
  await runInRootUnitOfWork(
    server.ctx.repoContext,
    { flush: undefined },
    () => server.ctx.repoContext.workflowRepo.save(workflow),
  );
}

function workflowPartition(name: string): PartitionKey {
  return partitionOf({ kind: "config", definitionKind: "workflow", name });
}

/** A workflow `name` whose one step runs `web`'s noop method. */
function runsWeb(name: string, id?: string): WorkflowEntity {
  return WorkflowEntity.create({
    ...(id === undefined ? {} : { id }),
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call",
            task: StepTask.modelMethod("web", "noop"),
          }),
        ],
      }),
    ],
  });
}

Deno.test({
  name:
    "forwarded content: a workflow step added to run a behavior the writer may not run is refused on both paths, and allowed on both when it may",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const writesWorkflows = grant({
      actions: ["read", "write", "run"],
      resource: { kind: "workflow", pattern: "*" },
    });
    // Reads behaviors, but may not run `web`.
    const readsModels = grant({
      actions: ["read"],
      resource: { kind: "model", pattern: "*" },
    });
    const runsModels = grant({
      actions: ["read", "run"],
      resource: { kind: "model", pattern: "*" },
    });
    const answers = async (grants: Grant[]) => {
      const results: string[] = [];
      for (const path of ["webSocket", "forwarded"]) {
        await withServer(
          grants,
          async (server) => {
            // A workflow with one gate; the edit adds a step running web.
            const stored = WorkflowEntity.create({
              name: "deploy",
              jobs: [
                Job.create({
                  name: "main",
                  steps: [
                    Step.create({
                      name: "gate",
                      task: StepTask.manualApproval("Go?"),
                    }),
                  ],
                }),
              ],
            });
            await saveWorkflow(server, stored);
            const edited = WorkflowEntity.fromData({
              ...JSON.parse(JSON.stringify(stored.toData())),
              jobs: [
                ...JSON.parse(JSON.stringify(stored.toData())).jobs,
                JSON.parse(JSON.stringify(runsWeb("x").toData())).jobs[0],
              ].map((job, i) => ({ ...job, name: i === 0 ? "main" : "call" })),
            });
            if (path === "webSocket") {
              const frames = await sendRequest(server.ctx, {
                type: "workflow.edit",
                id: crypto.randomUUID(),
                payload: {
                  workflowIdOrName: "deploy",
                  content: stringifyYaml(
                    JSON.parse(JSON.stringify(edited.toData())),
                  ),
                },
              });
              const error = errorFrame(frames);
              results.push(error === undefined ? "allowed" : error.error!.code);
            } else {
              const answer = await forward(
                server,
                workflowPartition("deploy"),
                [
                  put(
                    {
                      kind: "definition.edit",
                      definition: { kind: "workflow", name: "deploy" },
                    },
                    "config/workflows/workflow-deploy.yaml",
                    yaml(edited.toData()),
                  ),
                ],
              );
              results.push(
                answer.status === 200 ? "allowed" : String(answer.json.reason),
              );
            }
          },
          undefined,
          MANAGED,
        );
      }
      return results;
    };
    assertEquals(await answers([writesWorkflows, readsModels]), [
      "unauthorized",
      "content-refused",
    ]);
    assertEquals(await answers([writesWorkflows, runsModels]), [
      "allowed",
      "allowed",
    ]);
  },
});

Deno.test({
  name:
    "forwarded content: a behavior create may not take a name another behavior holds",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(
      member(),
      async (server) => {
        const type = server.modelType.normalized;
        // web exists; a second definition named web under a uuid key.
        const twin = Definition.create({
          name: "web",
          type,
          globalArguments: {},
        });
        const answer = await forward(server, behaviorPartition("web"), [
          put(
            {
              kind: "definition.create",
              definition: { kind: "model", name: "web" },
            },
            `config/models/${type}/${twin.id}.yaml`,
            yaml(twin.toData()),
          ),
        ]);
        assertEquals(answer.status, 403, JSON.stringify(answer.json));
        assertEquals(answer.json.reason, "content-refused");
      },
      undefined,
      MANAGED,
    );
  },
});

Deno.test({
  name:
    "forwarded content: an auto-definition may carry only what direct execution writes, unless the caller may edit the behavior",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const runOnly = grant({
      actions: ["read", "run"],
      resource: { kind: "model", pattern: "*" },
    });
    await withServer(
      [runOnly],
      async (server) => {
        const type = server.modelType.normalized;
        const save = (definition: Definition) =>
          forward(
            server,
            partitionOf({ kind: "definition", id: definition.id }),
            [
              put(
                {
                  kind: "auto-definition.save",
                  autoDefinition: { id: definition.id },
                },
                `auto-definitions/${type}/${definition.name}.yaml`,
                yaml(definition.toData()),
              ),
            ],
          );
        const direct = Definition.create({
          name: "adhoc",
          type,
          globalArguments: {},
        });
        const created = await save(direct);
        assertEquals(created.status, 200, JSON.stringify(created.json));
        const smuggled = Definition.create({
          name: "sneaky",
          type,
          globalArguments: {},
          methods: { noop: { arguments: { cmd: "rm -rf /" } } },
        });
        const refused = await save(smuggled);
        assertEquals(refused.status, 403, JSON.stringify(refused.json));
        assertEquals(refused.json.reason, "content-refused");
      },
      undefined,
      MANAGED,
    );
  },
});

Deno.test({
  name:
    "forwarded content: a local_encryption vault is renamed with vault edit, and a new one may not adopt leftover secrets",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const vaultWriter = grant({
      actions: ["read", "write"],
      resource: { kind: "vault", pattern: "*" },
    });
    await withServer(
      [vaultWriter],
      async (server) => {
        const config = (id: string, name: string) =>
          yaml({
            id,
            name,
            type: "local_encryption",
            config: {},
            createdAt: "2026-10-26T00:00:00.000Z",
          });
        const id = crypto.randomUUID();
        const key = `config/vaults/local_encryption/${id}.yaml`;
        const rename = await forward(
          server,
          partitionOf({ kind: "config", definitionKind: "vault", name: "new" }),
          [
            put(
              {
                kind: "definition.rename-to",
                definition: { kind: "vault", name: "new" },
                from: "old",
              },
              key,
              config(id, "new"),
            ),
          ],
        );
        assertEquals(rename.status, 403, JSON.stringify(rename.json));
        // Secrets an earlier vault named `kept` left behind.
        const leftovers = localEncryptionSecretsDirFor(
          server.ctx.repoDir,
          "kept",
        );
        await Deno.mkdir(leftovers, { recursive: true });
        await Deno.writeTextFile(join(leftovers, "token.enc"), "x");
        const keptId = crypto.randomUUID();
        const adopted = await forward(
          server,
          partitionOf({
            kind: "config",
            definitionKind: "vault",
            name: "kept",
          }),
          [
            put(
              {
                kind: "definition.create",
                definition: { kind: "vault", name: "kept" },
              },
              `config/vaults/local_encryption/${keptId}.yaml`,
              config(keptId, "kept"),
            ),
          ],
        );
        assertEquals(adopted.status, 403, JSON.stringify(adopted.json));
        assertEquals(adopted.json.reason, "content-refused");
      },
      undefined,
      MANAGED,
    );
  },
});

Deno.test({
  name:
    "forwarded content: an evaluated workflow named by an id, and a run snapshot, belong to the workflow their intent names",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const runsWorkflows = grant({
      actions: ["read", "run"],
      resource: { kind: "workflow", pattern: "*" },
    });
    await withServer(
      [runsWorkflows],
      async (server) => {
        const mine = runsWeb("mine");
        const theirs = runsWeb("theirs");
        await saveWorkflow(server, mine);
        await saveWorkflow(server, theirs);
        // Theirs, filed by its id, under my workflow's intent.
        const evaluated = await forward(server, workflowPartition("mine"), [
          put(
            {
              kind: "evaluated-workflow.save",
              definition: { kind: "workflow", name: "mine" },
            },
            `workflows-evaluated/workflow-${theirs.id}.yaml`,
            yaml(theirs.toData()),
          ),
        ]);
        assertEquals(evaluated.status, 403, JSON.stringify(evaluated.json));
        assertEquals(evaluated.json.reason, "content-refused");
        // A snapshot declaring another workflow than its run's.
        const runId = crypto.randomUUID();
        const snapshot = await forward(
          server,
          partitionOf({ kind: "run", workflowId: mine.id, runId }),
          [
            put(
              {
                kind: "run-snapshot.save",
                run: { workflowId: mine.id, runId },
              },
              `workflows-evaluated/runs/${runId}/evaluated-workflow.yaml`,
              yaml(theirs.toData()),
            ),
          ],
        );
        assertEquals(snapshot.status, 403, JSON.stringify(snapshot.json));
        assertEquals(snapshot.json.reason, "content-refused");
        const own = await forward(
          server,
          partitionOf({ kind: "run", workflowId: mine.id, runId }),
          [
            put(
              {
                kind: "run-snapshot.save",
                run: { workflowId: mine.id, runId },
              },
              `workflows-evaluated/runs/${runId}/evaluated-workflow.yaml`,
              yaml(mine.toData()),
            ),
          ],
        );
        assertEquals(own.status, 200, JSON.stringify(own.json));
      },
      undefined,
      MANAGED,
    );
  },
});

Deno.test({
  name:
    "forwarded content: a retry of a landed commit is answered after its chunk's grace window, for a writer who may not read the partition",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Runs web, but reads nothing: no partition vouches for its chunks.
    const runsOnly = grant({
      actions: ["run"],
      resource: { kind: "model", pattern: "*" },
    });
    const ledger = new UploadLedger({ graceMs: 1 });
    await withServer([runsOnly], async (server) => {
      const content = encoder.encode("payload");
      const sha = await sha256Hex(content);
      const partition = partitionOf({
        kind: "model",
        type: server.modelType,
        id: server.model.id,
      });
      const body = commitBody({
        expectedSeq: 0,
        txnId: crypto.randomUUID(),
        ops: await blobSaveOps(server, "vpc", 1, content),
        chunks: [{ sha256: sha, size: content.length }],
      }, [content]);
      const url = `${server.url}/partitions/${
        encodeURIComponent(partition.toString())
      }/commits`;
      const landed = await post(url, "alice-token", body);
      assertEquals(landed.status, 200, JSON.stringify(landed.json));
      await waitFor(
        () => !ledger.holds("user:caller", "_default", sha, Date.now()),
        "the upload's grace window to end",
      );
      // The same request again, with its chunk named but its entry gone.
      const named = new Uint8Array(body);
      const retried = await post(url, "alice-token", named);
      assertEquals(retried.status, 200, JSON.stringify(retried.json));
      assertEquals(retried.json.duplicate, true);
    }, ledger);
  },
});

Deno.test({
  name:
    "forwarded content: a record a commit was checked against that changes before it lands refuses it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(
      member(),
      async (server) => {
        const partition = behaviorPartition("web");
        const key = `config/models/${server.modelType.normalized}/web.yaml`;
        const authority = new ForwardedContentAuthority({
          ctx: server.ctx,
          v3: server.v3,
          partition,
          caller: {
            principal: { kind: "user", id: "caller" },
            collectives: [],
            groups: [],
            sourceIp: "127.0.0.1",
          },
          requestId: crypto.randomUUID(),
          resolver: {
            model: () => Promise.resolve(undefined),
            definitionTags: () => Promise.resolve(undefined),
            workflow: () => Promise.resolve(undefined),
            keyOwner: () => Promise.resolve(undefined),
            isRestrictedType: () => false,
          },
          possesses: () => Promise.resolve(true),
          signal: new AbortController().signal,
        });
        const edit = editedWeb(server, (data) => {
          data.description = "checked";
        });
        const op = (await import("../src/domain/datastore_v3/op.ts")).putOp;
        const intent = (await import("../src/domain/datastore_v3/intent.ts"))
          .createIntent({
            kind: "definition.edit",
            definition: { kind: "model", name: "web" },
          });
        const { RecordKey } = await import(
          "../src/domain/datastore_v3/record_key.ts"
        );
        const checked = await op({
          intent,
          key: RecordKey.create(key),
          inline: base64(yaml(edit.toData())),
        });
        // The API catches the read model up before it checks content.
        await server.v3.readModel.catchUp(new AbortController().signal);
        assertEquals(await authority.check(checked, [checked]), undefined);
        assert(await authority.unchanged());
        // Another edit lands in between.
        const moved = await forward(server, partition, [
          webEdit(
            server,
            editedWeb(server, (data) => {
              data.description = "moved";
            }),
          ),
        ]);
        assertEquals(moved.status, 200, JSON.stringify(moved.json));
        await server.v3.readModel.catchUp(new AbortController().signal);
        assertEquals(await authority.unchanged(), false);
      },
      undefined,
      MANAGED,
    );
  },
});

Deno.test({
  name:
    "forwarded content: an expression a stored definition already holds, copied to a new place, is checked as added",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // The stored definition reads data the writer cannot; the edit copies
    // that expression into a new argument.
    const reads = '${{ data.latest("vault-keeper", "token").attributes.v }}';
    const copy = (server: Server) =>
      editedWeb(server, (data) => {
        data.globalArguments = { stored: reads, copied: reads };
      });
    let webSocket = false;
    let forwarded = false;
    for (const path of ["webSocket", "forwarded"]) {
      await withServer(
        [writeModels],
        async (server) => {
          // Stored as an admin wrote it, bypassing the writer.
          const stored = editedWeb(server, (data) => {
            data.globalArguments = { stored: reads };
          });
          await runInRootUnitOfWork(
            server.ctx.repoContext,
            { flush: undefined },
            () =>
              server.ctx.repoContext.definitionRepo.save(
                server.modelType,
                stored,
              ),
          );
          if (path === "webSocket") {
            webSocket = await refusedOverWebSocket(server, copy(server));
          } else {
            const answer = await forward(server, behaviorPartition("web"), [
              webEdit(server, copy(server)),
            ]);
            forwarded = answer.status !== 200;
          }
        },
        undefined,
        MANAGED,
      );
    }
    assertEquals({ webSocket, forwarded }, {
      webSocket: true,
      forwarded: true,
    });
  },
});

Deno.test({
  name:
    "forwarded content: a data rename that moves a version, as the repository writes it, lands, and one that chooses new bytes is refused",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dataWriter = [
      ...member(),
      grant({ actions: ["write"], resource: { kind: "data", pattern: "*" } }),
    ];
    await withServer(dataWriter, async (server) => {
      const type = server.modelType.normalized;
      const id = server.model.id;
      const partition = partitionOf({
        kind: "model",
        type: server.modelType,
        id,
      });
      const base = `data/${type}/${id}`;
      const source = Data.create({
        name: "vpc",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "resource" },
        ownerDefinition: { ownerType: "manual", ownerRef: "test" },
      });
      const sourceData = JSON.parse(JSON.stringify(source.toData()));
      const content = encoder.encode('{"cidr":"10.0.0.0/16"}');
      const saveIntent = {
        kind: "data.save",
        model: { type, id },
        name: "vpc",
        version: 1,
      };
      const saved = await forward(server, partition, [
        put(saveIntent, `${base}/vpc/1/raw`, content),
        put(saveIntent, `${base}/vpc/1/metadata.yaml`, yaml(sourceData)),
        put(saveIntent, `${base}/vpc/latest`, encoder.encode("1")),
        {
          kind: "data-version",
          key: `${base}/vpc/1/metadata.yaml`,
          metadata: sourceData,
        },
      ]);
      assertEquals(saved.status, 200, JSON.stringify(saved.json));

      const renamed = (newContent: Uint8Array) => {
        const moved = JSON.parse(JSON.stringify(
          Data.create({
            name: "net",
            contentType: source.contentType,
            lifetime: source.lifetime,
            garbageCollection: source.garbageCollection,
            streaming: source.streaming,
            tags: { ...source.tags },
            ownerDefinition: { ...source.ownerDefinition },
          }).toData(),
        ));
        const marker = JSON.parse(JSON.stringify(
          source.withRenameMarker({ version: 2, renamedTo: "net" })
            .withNewVersion({ version: 2 }).toData(),
        ));
        const intent = {
          kind: "data.rename",
          model: { type, id },
          name: "vpc",
          to: "net",
        };
        return [
          put(intent, `${base}/net/1/raw`, newContent),
          put(intent, `${base}/net/1/metadata.yaml`, yaml(moved)),
          {
            kind: "data-version",
            key: `${base}/net/1/metadata.yaml`,
            metadata: moved,
          },
          put(intent, `${base}/net/latest`, encoder.encode("1")),
          put(
            intent,
            `${base}/vpc/2/raw`,
            encoder.encode(
              JSON.stringify({
                renamedTo: "net",
                renamedAt: new Date().toISOString(),
              }),
            ),
          ),
          put(intent, `${base}/vpc/2/metadata.yaml`, yaml(marker)),
          {
            kind: "data-version",
            key: `${base}/vpc/2/metadata.yaml`,
            metadata: marker,
          },
          put(intent, `${base}/vpc/latest`, encoder.encode("2")),
        ];
      };
      const minted = await forward(
        server,
        partition,
        renamed(encoder.encode('{"cidr":"0.0.0.0/0"}')),
      );
      assertEquals(minted.status, 403, JSON.stringify(minted.json));
      assertEquals(minted.json.reason, "content-refused");
      const moved = await forward(server, partition, renamed(content));
      assertEquals(moved.status, 200, JSON.stringify(moved.json));
    });
  },
});

Deno.test({
  name:
    "forwarded content: an auto-definition is promoted to a named behavior, and an adoption copy of a named behavior changes only its globals",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const editor = grant({
      actions: ["read", "write", "run"],
      resource: { kind: "model", pattern: "*" },
    });
    await withServer(
      [editor],
      async (server) => {
        const type = server.modelType.normalized;
        const adhoc = Definition.create({
          name: "adhoc",
          type,
          globalArguments: {},
        });
        const auto = await forward(
          server,
          partitionOf({ kind: "definition", id: adhoc.id }),
          [
            put(
              {
                kind: "auto-definition.save",
                autoDefinition: { id: adhoc.id },
              },
              `auto-definitions/${type}/adhoc.yaml`,
              yaml(adhoc.toData()),
            ),
          ],
        );
        assertEquals(auto.status, 200, JSON.stringify(auto.json));
        await server.v3.readModel.catchUp(new AbortController().signal);
        // Promoted: a named definition of the same id, type and name.
        const promoted = await forward(server, behaviorPartition("adhoc"), [
          put(
            {
              kind: "definition.create",
              definition: { kind: "model", name: "adhoc" },
            },
            `config/models/${type}/adhoc.yaml`,
            yaml(adhoc.toData()),
          ),
        ]);
        assertEquals(promoted.status, 200, JSON.stringify(promoted.json));

        // Direct execution on web with changed globals saves a copy here.
        const copy = (change: (data: Record<string, unknown>) => void) => {
          const data = JSON.parse(JSON.stringify(server.model.toData()));
          data.type = type;
          change(data);
          return forward(
            server,
            partitionOf({ kind: "definition", id: server.model.id }),
            [
              put(
                {
                  kind: "auto-definition.save",
                  autoDefinition: { id: server.model.id },
                },
                `auto-definitions/${type}/web.yaml`,
                yaml(Definition.fromData(data).toData()),
              ),
            ],
          );
        };
        const changedMethods = await copy((data) => {
          data.methods = { noop: { arguments: { x: 1 } } };
        });
        assertEquals(
          changedMethods.status,
          403,
          JSON.stringify(changedMethods.json),
        );
        const changedGlobals = await copy((data) => {
          data.globalArguments = {};
          data.version = 1;
        });
        assertEquals(
          changedGlobals.status,
          200,
          JSON.stringify(changedGlobals.json),
        );
      },
      undefined,
      MANAGED,
    );
  },
});

Deno.test({
  name:
    "forwarded content: a sensitive field may name a secret the caller may only write when it is under the behavior's own derived key",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Writes vaults but reads none of them, and reads only web's data.
    const runner = [
      writeModels,
      grant({ actions: ["read"], resource: { kind: "data", pattern: "web" } }),
      grant({ actions: ["write"], resource: { kind: "vault", pattern: "*" } }),
    ];
    await withServer(runner, async (server) => {
      const type = server.modelType.normalized;
      const id = server.model.id;
      const save = (version: number, secretKey: string) => {
        const base = `data/${type}/${id}/creds/${version}`;
        const intent = {
          kind: "data.save",
          model: { type, id },
          name: "creds",
          version,
        };
        const metadata = {
          name: "creds",
          id: crypto.randomUUID(),
          version,
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 10,
          tags: {
            type: "resource",
            "_swamp.sensitiveFields": JSON.stringify(["token"]),
            "_swamp.sensitiveFieldsVersion": "1",
          },
          ownerDefinition: { ownerType: "model-method", ownerRef: id },
          createdAt: "2026-10-26T00:00:00.000Z",
        };
        const raw = encoder.encode(
          JSON.stringify({
            token: "${{ vault.get('prod', '" + secretKey + "') }}",
          }),
        );
        return forward(
          server,
          partitionOf({ kind: "model", type: server.modelType, id }),
          [
            put(intent, `${base}/raw`, raw),
            put(intent, `${base}/metadata.yaml`, yaml(metadata)),
            { kind: "data-version", key: `${base}/metadata.yaml`, metadata },
          ],
        );
      };
      const own = `${type.replaceAll("/", "-")}-${id}-noop-creds-main-token`;
      const derived = await save(1, own);
      assertEquals(derived.status, 200, JSON.stringify(derived.json));
      const declared = await save(2, "shared-payments-key");
      assertEquals(declared.status, 403, JSON.stringify(declared.json));
      assertEquals(declared.json.reason, "content-refused");
    });
  },
});

Deno.test({
  name:
    "forwarded content: a nested run names a parent that has not finished, and an inherited env expression needs write on its workflow",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const runsOnly = grant({
      actions: ["read", "run"],
      resource: { kind: "workflow", pattern: "*" },
    });
    await withServer([runsOnly], async (server) => {
      const parentId = crypto.randomUUID();
      const parent = await forwardRun(
        server,
        runRecord(parentId, { status: "suspended" }),
      );
      assertEquals(parent.status, 200, JSON.stringify(parent.json));
      const parentRun = {
        workflowId: WORKFLOW,
        workflowName: "deploy",
        runId: parentId,
        jobName: "main",
        stepName: "call",
        nestingDepth: 1,
        ancestorWorkflowNames: ["deploy"],
      };
      const child = await forwardRun(
        server,
        runRecord(crypto.randomUUID(), { parentRun }),
      );
      assertEquals(child.status, 200, JSON.stringify(child.json));
      const orphan = await forwardRun(
        server,
        runRecord(crypto.randomUUID(), {
          parentRun: { ...parentRun, runId: crypto.randomUUID() },
        }),
      );
      assertEquals(orphan.status, 403, JSON.stringify(orphan.json));
      // An env read handed down from a parent is authored by the caller.
      const env = await forwardRun(
        server,
        runRecord(crypto.randomUUID(), {
          inheritedExpressions: ["${{ env.DEPLOY_TOKEN }}"],
        }),
      );
      assertEquals(env.status, 403, JSON.stringify(env.json));
      assertEquals(env.json.reason, "content-refused");
    });
  },
});

Deno.test({
  name:
    "forwarded content: a record past the read cap is unreadable, never read whole, and a removal may not raise a latest marker",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dataWriter = [
      ...member(),
      grant({ actions: ["write"], resource: { kind: "data", pattern: "*" } }),
    ];
    await withServer(
      dataWriter,
      async (server) => {
        const key = `config/models/${server.modelType.normalized}/web.yaml`;
        const partition = behaviorPartition("web");
        await server.v3.readModel.catchUp(new AbortController().signal);
        assert(
          await server.v3.readModel.recordBytes(
            server.v3.namespace,
            partition,
            key,
          ) !== undefined,
        );
        assertEquals(
          await server.v3.readModel.recordBytes(
            server.v3.namespace,
            partition,
            key,
            1,
          ),
          undefined,
        );

        const type = server.modelType.normalized;
        const id = server.model.id;
        const data = partitionOf({ kind: "model", type: server.modelType, id });
        const base = `data/${type}/${id}/vpc`;
        const versions = [1, 2].flatMap((version) => {
          const intent = {
            kind: "data.save",
            model: { type, id },
            name: "vpc",
            version,
          };
          const metadata = {
            name: "vpc",
            id: crypto.randomUUID(),
            version,
            contentType: "application/json",
            lifetime: "infinite",
            garbageCollection: 10,
            tags: { type: "resource" },
            ownerDefinition: { ownerType: "manual", ownerRef: "test" },
            createdAt: "2026-10-26T00:00:00.000Z",
          };
          return [
            put(intent, `${base}/${version}/raw`, encoder.encode("{}")),
            put(intent, `${base}/${version}/metadata.yaml`, yaml(metadata)),
            {
              kind: "data-version",
              key: `${base}/${version}/metadata.yaml`,
              metadata,
            },
          ];
        });
        const saved = await forward(server, data, [
          ...versions,
          put(
            { kind: "data.save", model: { type, id }, name: "vpc", version: 1 },
            `${base}/latest`,
            encoder.encode("1"),
          ),
        ]);
        assertEquals(saved.status, 200, JSON.stringify(saved.json));
        const marker = (version: string) =>
          forward(server, data, [
            put(
              { kind: "data.delete", model: { type, id }, name: "vpc" },
              `${base}/latest`,
              encoder.encode(version),
            ),
          ]);
        const raised = await marker("2");
        assertEquals(raised.status, 403, JSON.stringify(raised.json));
        assertEquals(raised.json.reason, "content-refused");
        const kept = await marker("1");
        assertEquals(kept.status, 200, JSON.stringify(kept.json));
      },
      undefined,
      MANAGED,
    );
  },
});

Deno.test({
  name:
    "forwarded content: serve runs its own fresh evaluation, read through the trust with no other catch-up",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const admin = grant({
      actions: ["admin"],
      resource: { kind: "access", pattern: "*" },
    });
    await withServer(
      [admin],
      async (server) => {
        const trust = v3EvaluationTrust(server.v3, server.ctx.repoContext);
        // Serve evaluates web twice: the second is a re-evaluation of a record
        // the read model already holds.
        for (let round = 0; round < 2; round++) {
          const frames = await sendRequest(server.ctx, {
            type: "model.evaluate",
            id: crypto.randomUUID(),
            payload: { modelIdOrName: "web" },
          });
          assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
          const cache = await trust.definition(server.modelType, "web");
          assertEquals(cache?.definition.id, server.model.id, `round ${round}`);
        }
        await saveWorkflow(server, runsWeb("deploy"));
        const evaluated = await sendRequest(server.ctx, {
          type: "workflow.evaluate",
          id: crypto.randomUUID(),
          payload: { workflowIdOrName: "deploy" },
        });
        assertEquals(
          errorFrame(evaluated),
          undefined,
          JSON.stringify(evaluated),
        );
        assertEquals((await trust.workflow("deploy"))?.workflow.name, "deploy");
      },
      undefined,
      MANAGED,
    );
  },
});
