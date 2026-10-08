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
 * Shared fixture for the serve run vault scope integration tests
 * (swamp-club#2676): a real repository on disk with three local_encryption
 * vaults (`erp`, `roomcontrol`, `outputs`), a per-run model type whose
 * methods read a vault through an expression, drive `context.vaultService`
 * and write a sensitive output, and a connection context whose policy can be
 * swapped mid-run. Requests go through serve's real handlers.
 */

import { assert } from "@std/assert";
import { z } from "zod";
import { GrantBasedAccessDecisionService } from "../src/domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../src/domain/access/policy_snapshot.ts";
import {
  createConditionEvaluator,
  type PolicySnapshotLoader,
} from "../src/domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../src/domain/access/principal.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import type { Group } from "../src/domain/models/access/group_model.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import { RefreshHook } from "../src/domain/vaults/refresh_hook.ts";
import { VaultAnnotation } from "../src/domain/vaults/vault_annotation.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { withoutVaultAccess } from "../src/domain/vaults/run_vault_access.ts";
import type { Workflow } from "../src/domain/workflows/workflow.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import {
  type ConnectionContext,
  removeConnection,
  setConnectionCollectives,
  setConnectionToken,
  type TokenSessionBinding,
} from "../src/serve/handlers/shared.ts";
import { handleMessage } from "../src/serve/connection.ts";
import { readServerTokenRecord } from "../src/serve/token_auth.ts";
import { Data } from "../src/domain/data/data.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../src/domain/models/access/server_token_model.ts";
import { waitFor } from "@swamp-club/swamp-testing";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import {
  createServeCtx,
  type Frame,
  sendRequest,
  type ServeCtxOptions,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

/** The secret each fixture vault holds under the key `password`. */
export const SECRETS = {
  erp: "erp-secret-value",
  roomcontrol: "roomcontrol-secret-value",
} as const;

/** A bot whose runs the tests scope; it runs and reads anything else. */
export const BOT: Principal = { kind: "user", id: "bot" };
/** An approver/resumer holding no vault grant. */
export const ROOT: Principal = { kind: "user", id: "root" };
/** An access admin (admin on access:*). */
export const ADMIN: Principal = { kind: "user", id: "admin" };

/** A grant; `subject` is `kind:name`, e.g. `user:bot`. */
export function grant(
  subject: string,
  kind: Grant["resource"]["kind"],
  pattern: string,
  actions: Grant["actions"] = ["read"],
  effect: Grant["effect"] = "allow",
): Grant {
  const at = subject.indexOf(":");
  return {
    id: crypto.randomUUID(),
    subject: {
      kind: subject.slice(0, at) as Grant["subject"]["kind"],
      name: subject.slice(at + 1),
    },
    effect,
    actions,
    resource: { kind, pattern },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

/** Run, read and write anything but vaults, and approve workflows. */
export function runnerGrants(subject: string): Grant[] {
  return [
    grant(subject, "model", "*", ["read", "write", "run"]),
    grant(subject, "workflow", "*", ["read", "write", "run", "approve"]),
    grant(subject, "data", "*", ["read", "write"]),
  ];
}

/** bot reads only roomcontrol; root runs and approves with no vault grant. */
export function roomcontrolOnly(): Grant[] {
  return [
    ...runnerGrants("user:bot"),
    grant("user:bot", "vault", "roomcontrol"),
    ...runnerGrants("user:root"),
  ];
}

/** The outcome of each `context.vaultService` operation the `ops` method tried. */
export type OpsOutcome = Record<string, string>;

/** Hooks a test sets to act inside a method's execution. */
export interface MethodHooks {
  /** Called inside `mint` after its side effect, before it writes output. */
  beforeMintWrite?: () => void | Promise<void>;
  /** Called inside `read` after it recorded its value. */
  afterRead?: () => void | Promise<void>;
}

export interface VaultScopeFixture {
  repo: ServeRepo;
  ctx: ConnectionContext;
  /** Every audit event serve emitted. */
  audits: AuditEvent[];
  /** The test model type, registered per run. */
  type: ModelType;
  /** Values the `read` method received, in order. */
  seen: string[];
  /** Outcomes of each `ops` call. */
  ops: OpsOutcome[];
  /** How many times `mint` reached its external side effect. */
  sideEffects: { count: number };
  /** Calls to `read` that fail on purpose before recording. */
  failNext: { count: number };
  hooks: MethodHooks;
  /** Replaces the policy every later decision reads. */
  setPolicy(grants: Grant[], groups?: Group[]): void;
  /** A vault service over the repo, used outside any run scope. */
  vaults(): Promise<VaultService>;
  /**
   * A connection context over freshly opened repositories, as a restarted
   * serve process would have, sharing this fixture's policy and audit.
   */
  restartedCtx(options?: ServeCtxOptions): Promise<ConnectionContext>;
}

/** The run-time vault denials among `audits`. */
export function vaultDenials(audits: AuditEvent[]): AuditEvent[] {
  return audits.filter((e) =>
    e.category === "secrets" && e.outcome === "denied" &&
    e.resourceKind === "vault"
  );
}

function decisionService(
  grants: Grant[],
  groups: Group[],
): GrantBasedAccessDecisionService {
  return new GrantBasedAccessDecisionService(
    new PolicySnapshot(grants, groups, createConditionEvaluator()),
  );
}

/** Saves a local_encryption vault named `name`, optionally with a secret. */
export async function createVault(
  repoDir: string,
  name: string,
  secret?: string,
): Promise<void> {
  await new YamlVaultConfigRepository(repoDir).save(
    VaultConfig.create(crypto.randomUUID(), name, "local_encryption", {
      auto_generate: true,
      base_dir: repoDir,
    }),
  );
  if (secret !== undefined) {
    const vaults = await VaultService.fromRepository(repoDir);
    await withoutVaultAccess(() => vaults.put(name, "password", secret));
  }
}

/** Saves a definition of the fixture type. */
export async function saveDefinition(
  f: Pick<VaultScopeFixture, "repo" | "type">,
  name: string,
  props: Partial<Parameters<typeof Definition.create>[0]> = {},
): Promise<Definition> {
  const definition = Definition.create({ name, ...props });
  await f.repo.repoContext.definitionRepo.save(f.type, definition);
  return definition;
}

/** A `read` definition whose argument is `value`. */
export function readerOf(
  f: Pick<VaultScopeFixture, "repo" | "type">,
  name: string,
  value: string,
): Promise<Definition> {
  return saveDefinition(f, name, {
    methods: { read: { arguments: { value } } },
  });
}

/** `${{ vault.get('<vault>', 'password') }}`. */
export function vaultRef(vault: string, key = "password"): string {
  return `\${{ vault.get('${vault}', '${key}') }}`;
}

/**
 * Runs `fn` against a fresh repo with vaults `erp` and `roomcontrol`
 * (holding {@link SECRETS}) and an empty `outputs` vault, readers
 * `erp-reader` and `rc-reader`, an `ops` definition, a `minter` whose
 * sensitive output lands in `outputs`, and a `creds-reader` that reads it
 * back.
 */
export async function withVaultScopeFixture(
  fn: (f: VaultScopeFixture) => Promise<void>,
  options: {
    grants?: Grant[];
    groups?: Group[];
    ctx?: ServeCtxOptions;
    /** The vault the minter's spec names; `outputs` by default. */
    mintVault?: string;
    /** The `vaultKey` the minter's `token` field fixes; generated if unset. */
    mintTokenKey?: string;
  } = {},
): Promise<void> {
  // Deno can call a test with the async context the previous test left
  // behind, so each fixture starts outside any vault scope.
  await withoutVaultAccess(() =>
    withServeRepo(async (repo) => {
      const type = ModelType.create(`test/vault-scope-${crypto.randomUUID()}`);
      const seen: string[] = [];
      const ops: OpsOutcome[] = [];
      const sideEffects = { count: 0 };
      const failNext = { count: 0 };
      const hooks: MethodHooks = {};
      const reopened: { catalogStore: { close(): void } }[] = [];
      modelRegistry.register({
        type,
        version: "2026.10.07.1",
        globalArguments: z.object({}),
        resources: {
          creds: {
            description: "A minted credential",
            schema: z.object({
              name: z.string(),
              token: z.string().meta(
                options.mintTokenKey === undefined
                  ? { sensitive: true }
                  : { sensitive: true, vaultKey: options.mintTokenKey },
              ),
              backup: z.string().meta({ sensitive: true }),
            }),
            lifetime: "infinite",
            garbageCollection: 5,
            vaultName: options.mintVault ?? "outputs",
          },
        },
        methods: {
          read: {
            description: "Records the value it was given",
            kind: "read",
            arguments: z.object({ value: z.string() }),
            execute: async (args) => {
              if (failNext.count > 0) {
                failNext.count--;
                throw new Error("read failed on purpose");
              }
              seen.push((args as { value: string }).value);
              await hooks.afterRead?.();
              return {};
            },
          },
          ops: {
            description: "Tries every vault operation on a vault",
            kind: "read",
            arguments: z.object({ vault: z.string() }),
            execute: async (args, context) => {
              const vs = context.vaultService!;
              const outcome: OpsOutcome = {};
              const attempt = async (
                name: string,
                op: () => Promise<unknown>,
              ) => {
                try {
                  await op();
                  outcome[name] = "ok";
                } catch (error) {
                  outcome[name] = error instanceof Error
                    ? error.message
                    : String(error);
                }
              };
              const v = (args as { vault: string }).vault;
              await attempt("get", () => vs.get(v, "password"));
              await attempt("list", () => vs.list(v));
              await attempt("put", () => vs.put(v, "written", "x"));
              await attempt("delete", () => vs.delete(v, "written"));
              await attempt("getAnnotation", () =>
                vs.getAnnotation(v, "password"));
              await attempt("putAnnotation", () =>
                vs.putAnnotation(
                  v,
                  "password",
                  VaultAnnotation.create({ notes: "annotated" }),
                ));
              await attempt("deleteAnnotation", () =>
                vs.deleteAnnotation(v, "password"));
              await attempt("getRefreshHook", () =>
                vs.getRefreshHook(v, "password"));
              await attempt("putRefreshHook", () =>
                vs.putRefreshHook(
                  v,
                  "password",
                  RefreshHook.create("echo refreshed", 60_000),
                ));
              await attempt("deleteRefreshHook", () =>
                vs.deleteRefreshHook(v, "password"));
              ops.push(outcome);
              return {};
            },
          },
          mint: {
            description: "Calls out, then stores a sensitive credential",
            kind: "create",
            arguments: z.object({}),
            execute: async (_args, context) => {
              // The external side effect a pre-run refusal must prevent.
              sideEffects.count++;
              await hooks.beforeMintWrite?.();
              const handle = await context.writeResource!("creds", "main", {
                name: "app",
                token: `minted-${sideEffects.count}`,
                backup: `backup-${sideEffects.count}`,
              });
              return { dataHandles: [handle] };
            },
          },
        },
      });
      try {
        await createVault(repo.repoDir, "erp", SECRETS.erp);
        await createVault(repo.repoDir, "roomcontrol", SECRETS.roomcontrol);
        await createVault(repo.repoDir, "outputs");
        const ctx = createServeCtx(repo, [], options.ctx);
        let service = decisionService(
          options.grants ?? roomcontrolOnly(),
          options.groups ?? [],
        );
        (ctx as { policySnapshotLoader: unknown }).policySnapshotLoader = {
          get decisionService() {
            return service;
          },
          get snapshot() {
            return service.snapshot;
          },
        } as unknown as PolicySnapshotLoader;
        const audits: AuditEvent[] = [];
        (ctx as { auditEmitter: unknown }).auditEmitter = {
          emit: (event: AuditEvent) =>
            audits.push(event),
        } as unknown as AuditEmitter;
        (ctx as { instanceId: string }).instanceId = crypto.randomUUID();
        const f: VaultScopeFixture = {
          repo,
          ctx,
          audits,
          type,
          seen,
          ops,
          sideEffects,
          failNext,
          hooks,
          setPolicy(grants, groups = []) {
            service = decisionService(grants, groups);
          },
          vaults: () =>
            VaultService.fromRepository(repo.repoDir),
          restartedCtx: async (ctxOptions) => {
            const opened = await requireInitializedRepoUnlocked({
              repoDir: repo.repoDir,
              outputMode: "log",
            });
            reopened.push(opened.repoContext);
            const next = createServeCtx(
              {
                ...repo,
                repoContext: opened.repoContext,
                datastoreConfig: opened.datastoreConfig,
              },
              [],
              ctxOptions,
            );
            return {
              ...next,
              policySnapshotLoader: ctx.policySnapshotLoader,
              auditEmitter: ctx.auditEmitter,
              instanceId: crypto.randomUUID(),
            } as ConnectionContext;
          },
        };
        await readerOf(f, "erp-reader", vaultRef("erp"));
        await readerOf(f, "rc-reader", vaultRef("roomcontrol"));
        await saveDefinition(f, "ops", {
          inputs: {
            type: "object",
            properties: { vault: { type: "string" } },
          },
          methods: { ops: { arguments: { vault: "${{ inputs.vault }}" } } },
        });
        await saveDefinition(f, "minter");
        await readerOf(
          f,
          "creds-reader",
          "${{ data.latest('minter', 'main').attributes.token }}",
        );
        await fn(f);
      } finally {
        modelRegistry.invalidateType(type);
        for (const opened of reopened) {
          opened.catalogStore.close();
        }
        repo.repoContext.catalogStore.close();
      }
    })
  );
}

function request(type: string, payload: Record<string, unknown>) {
  return { type, id: crypto.randomUUID(), payload };
}

/** Sends `workflow.run` as `principal` and returns the run it started. */
export async function runWorkflowAs(
  f: VaultScopeFixture,
  workflow: Workflow,
  principal: Principal | null,
  ctx: ConnectionContext = f.ctx,
): Promise<{ run: WorkflowRun; frames: Frame[] }> {
  await f.repo.repoContext.workflowRepo.save(workflow);
  const frames = await sendRequest(
    ctx,
    request("workflow.run", { workflowIdOrName: workflow.name }),
    principal,
  );
  const started = frames.find((frame) =>
    (frame.payload as { kind?: string } | undefined)?.kind === "started" ||
    (frame as { event?: { kind?: string } }).event?.kind === "started"
  );
  const runId = (started?.payload as { runId?: string } | undefined)?.runId ??
    (started as { event?: { runId?: string } } | undefined)?.event?.runId ??
    (await f.repo.repoContext.workflowRunRepo.findLatestByWorkflowId(
      createWorkflowId(workflow.id),
    ))?.id;
  assert(runId, `no run started: ${JSON.stringify(frames).slice(0, 800)}`);
  return { run: (await loadRun(f, workflow, runId))!, frames };
}

/** Reads a run of `workflow` back from the repo. */
export async function loadRun(
  f: Pick<VaultScopeFixture, "repo">,
  workflow: Workflow,
  runId: string,
): Promise<WorkflowRun | null> {
  return await f.repo.repoContext.workflowRunRepo.findById(
    createWorkflowId(workflow.id),
    createWorkflowRunId(runId),
  );
}

/** Sends `model.method.run` as `principal`. */
export async function runMethodAs(
  f: VaultScopeFixture,
  modelIdOrName: string,
  methodName: string,
  principal: Principal | null,
  inputs: Record<string, unknown> = {},
  ctx: ConnectionContext = f.ctx,
  extra: Record<string, unknown> = {},
): Promise<Frame[]> {
  return await sendRequest(
    ctx,
    request("model.method.run", {
      modelIdOrName,
      methodName,
      inputs,
      ...extra,
    }),
    principal,
  );
}

/** The error text a method run reported, from its error frame or event. */
export function methodError(frames: Frame[]): string | undefined {
  for (const frame of frames) {
    if (frame.type === "error") return frame.error?.message;
    const event = (frame.payload ?? (frame as { event?: unknown }).event) as
      | { kind?: string; error?: { message?: string } | string }
      | undefined;
    if (event?.kind === "error") {
      return typeof event.error === "string"
        ? event.error
        : event.error?.message;
    }
  }
  return undefined;
}

/** A step's status and error in `run`. */
export function stepOf(
  run: WorkflowRun,
  job: string,
  step: string,
): { status?: string; error?: string } {
  const s = run.getJob(job)?.getStep(step);
  return { status: s?.status, error: s?.error };
}

/** Sends `workflow.resume` of `runId` as `principal`. */
export async function resumeAs(
  f: VaultScopeFixture,
  workflow: Workflow,
  runId: string,
  principal: Principal | null,
  ctx: ConnectionContext = f.ctx,
): Promise<Frame[]> {
  return await sendRequest(
    ctx,
    request("workflow.resume", { workflowIdOrName: workflow.name, runId }),
    principal,
  );
}

/** Sends `workflow.approve` of gate `stepName` in `runId` as `principal`. */
export async function approveAs(
  f: VaultScopeFixture,
  workflow: Workflow,
  runId: string,
  stepName: string,
  principal: Principal | null,
  ctx: ConnectionContext = f.ctx,
): Promise<Frame[]> {
  return await sendRequest(
    ctx,
    request("workflow.approve", {
      workflowIdOrName: workflow.name,
      runId,
      stepName,
    }),
    principal,
  );
}

/** How a request's socket is set up before it is sent. */
export interface SessionSetup {
  /** IdP groups an OAuth session carries. */
  idpGroups?: string[];
  /** The server token binding of a token session. */
  token?: TokenSessionBinding;
}

/**
 * Sends one request through `handleMessage` on a socket set up as `session`
 * describes, and returns every frame sent for it once it and every detached
 * run it started are done.
 */
export async function sendAs(
  ctx: ConnectionContext,
  type: string,
  payload: Record<string, unknown>,
  principal: Principal | null,
  session: SessionSetup = {},
): Promise<Frame[]> {
  const id = crypto.randomUUID();
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    close() {},
  } as unknown as WebSocket;
  if (session.idpGroups) {
    setConnectionCollectives(socket, [], session.idpGroups);
  }
  if (session.token) setConnectionToken(socket, session.token);
  const active = new Map<string, AbortController>();
  try {
    handleMessage(
      socket,
      ctx,
      active,
      new MessageEvent("message", {
        data: JSON.stringify({ type, id, payload }),
      }),
      principal,
    );
    await waitFor(
      () => !active.has(id) && (ctx.activeRunRegistry?.size ?? 0) === 0,
      `request ${type} ${id} finished`,
    );
  } finally {
    removeConnection(socket);
  }
  return sent.map((raw) => JSON.parse(raw) as Frame).filter((frame) =>
    frame.id === undefined || frame.id === id
  );
}

/**
 * Saves an active server token record for `principal`, as a mint would,
 * and returns the binding a session opened with it carries.
 */
export async function saveTokenRecord(
  repo: ServeRepo,
  principal: Principal,
  groups: string[] = [],
): Promise<TokenSessionBinding> {
  const name = `token-${crypto.randomUUID().slice(0, 8)}`;
  const definition = Definition.create({ name });
  await repo.repoContext.definitionRepo.save(
    SERVER_TOKEN_MODEL_TYPE,
    definition,
  );
  const createdAt = new Date().toISOString();
  const principalId = `${principal.kind}:${principal.id}`;
  const record = {
    name,
    state: "active",
    principalId,
    principalEmail: `${principal.id}@example.com`,
    collectives: [],
    groups,
    createdAt,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    vaultName: "_token-secrets",
    secretKey: `${name}-secret`,
  };
  await writeTokenRecord(repo, definition, record);
  return { name, createdAt, principalId };
}

/** Marks the server token `binding` names revoked, as `token revoke` does. */
export async function revokeTokenRecord(
  repo: ServeRepo,
  binding: TokenSessionBinding,
): Promise<void> {
  const definition = await repo.repoContext.definitionRepo.findByName(
    SERVER_TOKEN_MODEL_TYPE,
    binding.name,
  );
  if (!definition) throw new Error(`no server token ${binding.name}`);
  const record = await readServerTokenRecord(repo.repoContext, binding.name);
  await writeTokenRecord(repo, definition, { ...record, state: "revoked" });
}

async function writeTokenRecord(
  repo: ServeRepo,
  definition: Definition,
  record: Record<string, unknown>,
): Promise<void> {
  await repo.repoContext.unifiedDataRepo.save(
    SERVER_TOKEN_MODEL_TYPE,
    definition.id,
    Data.create({
      name: "token-main",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource", modelName: name },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: `${SERVER_TOKEN_MODEL_TYPE.normalized}:${definition.id}`,
      },
    }),
    new TextEncoder().encode(JSON.stringify(record)),
  );
}
