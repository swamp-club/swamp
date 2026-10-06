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
 * Fixtures for the use-case sync characterization (swamp-club#2860): run a
 * datastore-writing use case through the CLI composition (the real Cliffy
 * command parsed in-process, then `flushDatastoreSync()` as `src/cli/mod.ts`
 * does at teardown) or the serve composition (`handleMessage`, so
 * `connection.ts` applies `withSyncGate`), against a repo wired to an
 * in-memory remote, and observe which paths were marked and what was pushed.
 *
 * Each row gets its own remote and two per-run datastore types — instance
 * "A" (the repo the use case runs in) and "B" (a peer used to settle seeds) —
 * so the op log of one row never mixes with another's.
 */

import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { Command } from "@cliffy/command";
import { z } from "zod";
import {
  createInMemoryRemote,
  type InMemoryRemote,
  type InMemoryRemoteOptions,
  withMockedFetch,
} from "@swamp-club/swamp-testing";
import {
  cacheRelativeMarkPath,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import {
  ModelNameType,
  ModelTypeType,
  WorkflowNameType,
} from "../src/cli/completion_types.ts";
import { accessCommand } from "../src/cli/commands/access.ts";
import { dataCommand } from "../src/cli/commands/data.ts";
import { datastoreCommand } from "../src/cli/commands/datastore.ts";
import { extensionCommand } from "../src/cli/commands/extension.ts";
import { modelCommand } from "../src/cli/commands/model_create.ts";
import { runCommand } from "../src/cli/commands/run.ts";
import { vaultCommand } from "../src/cli/commands/vault.ts";
import { workerCommand } from "../src/cli/commands/worker.ts";
import { workflowCommand } from "../src/cli/commands/workflow.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  flushDatastoreSync,
  getRegisteredLockKeys,
} from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import {
  configureTestDatastore,
  registerTestDatastoreType,
} from "../src/infrastructure/testing/test_datastore_type.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import type { UnitOfWork } from "../src/domain/datastore/unit_of_work.ts";
import {
  createLegacyUnitOfWork,
  legacyUnitOfWorkParent,
  legacyUnitOfWorkTarget,
} from "../src/infrastructure/persistence/legacy_unit_of_work.ts";
import {
  type BoundUnitOfWorkOptions,
  useUnitOfWorkFactoryForTesting,
} from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { ReadWriteLock } from "../src/infrastructure/stream/read_write_lock.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  sendRequest,
  type ServeRepo,
} from "./serve_request_harness.ts";
import { withUnscopedWriteGuard } from "./unscoped_write_guard.ts";

/** Which composition a row runs through. */
export type Composition = "cli" | "serve";

/** The repo context `requireInitializedRepoUnlocked` builds. */
export type UnlockedRepo = Awaited<
  ReturnType<typeof requireInitializedRepoUnlocked>
>;

/** Options for {@link withRowRepos}. */
export interface RowRepoOptions {
  /** Add `managedConfig: true` under the repos' `datastore:` block. */
  managedConfig?: boolean;
  /** Options for the row's in-memory remote. */
  remote?: InMemoryRemoteOptions;
}

/** One row's remote, its two repos, and A's open repo context. */
export interface RowRepos {
  remote: InMemoryRemote;
  repoA: string;
  repoB: string;
  /**
   * A per-run model type with a no-op read method, `noop`, and a no-op
   * update, `touch`, which a run takes model locks for.
   */
  modelType: ModelType;
  /**
   * A's repository context, with the markDirty hook wired to A's sync
   * service. Seeds go through it; the serve composition uses it as serve's
   * one shared context.
   */
  a: UnlockedRepo;
  /** {@link a} in the shape the serve harness takes. */
  serveRepo: ServeRepo;
  /**
   * The remote op-log length at each release of one of A's datastore locks
   * and at each exit from serve's sync gate, in order: where a push sits
   * relative to the lock or gate it ran under.
   */
  releases: number[];
}

/** The marker line `withRowRepos` appends for `managedConfig`. */
const MANAGED_CONFIG_LINE = "  managedConfig: true";

async function initRepo(
  repoDir: string,
  typeName: string,
  managedConfig: boolean,
): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  await configureTestDatastore(repoDir, typeName);
  if (managedConfig) {
    // configureTestDatastore appends the datastore block last, so this line
    // lands inside it.
    const markerPath = join(repoDir, ".swamp.yaml");
    const marker = await Deno.readTextFile(markerPath);
    await Deno.writeTextFile(
      markerPath,
      marker.trimEnd() + "\n" + MANAGED_CONFIG_LINE + "\n",
    );
  }
}

/** The datastore cache directory of a repo wired by {@link withRowRepos}. */
export function cacheDir(repoDir: string): string {
  return join(repoDir, ".test-cache");
}

/**
 * Runs `fn` against a fresh remote and two repos, A and B, each on its own
 * per-run datastore type connecting to that remote as instance "A" or "B".
 * Everything is torn down in a `finally`: pending syncs are flushed, both
 * datastore types and the model type are unregistered, and the temp dir is
 * removed.
 */
export async function withRowRepos(
  options: RowRepoOptions,
  fn: (repos: RowRepos) => Promise<void>,
): Promise<void> {
  assertEquals(
    getRegisteredLockKeys(),
    [],
    "a previous row left a datastore sync registered",
  );
  const remote = createInMemoryRemote(options.remote);
  const releases: number[] = [];
  const typeA = registerTestDatastoreType({
    connect: (cache) => remote.connect(cache, { instance: "A" }),
  }, { onLockRelease: () => releases.push(remote.ops().length) });
  const typeB = registerTestDatastoreType({
    connect: (cache) => remote.connect(cache, { instance: "B" }),
  });
  const modelType = ModelType.create(
    `test/usecase-${crypto.randomUUID().slice(0, 8)}`,
  );
  modelRegistry.register({
    type: modelType,
    version: "2026.01.01.1",
    methods: {
      noop: {
        description: "does nothing",
        kind: "read",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
      touch: {
        description: "an update that writes nothing",
        kind: "update",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  });
  const dir = await Deno.makeTempDir({ prefix: "swamp-usecase-sync-" });
  try {
    const repoA = join(dir, "a");
    const repoB = join(dir, "b");
    const managed = options.managedConfig === true;
    await initRepo(repoA, typeA.typeName, managed);
    await initRepo(repoB, typeB.typeName, managed);
    const a = await requireInitializedRepoUnlocked({
      repoDir: repoA,
      outputMode: "json",
    });
    // A hooked write from production code that takes signalChange's hook
    // fallback fails the test, seeds included (swamp-club#3056).
    await withUnscopedWriteGuard(() =>
      fn({
        remote,
        repoA,
        repoB,
        modelType,
        a,
        serveRepo: {
          repoDir: a.repoDir,
          repoContext: a.repoContext,
          datastoreConfig: a.datastoreConfig,
          datastoreResolver: a
            .datastoreResolver as ConnectionContext["datastoreResolver"],
          modelType,
        },
        releases,
      })
    );
  } finally {
    await flushDatastoreSync();
    typeA.dispose();
    typeB.dispose();
    modelRegistry.invalidateType(modelType);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/**
 * Lands every seed on the remote before the baseline: flushes any
 * registered sync, pushes A's pending marks, and pulls them into B. Without
 * it a seed never reaches the remote, and a delete shows as deleting
 * nothing.
 */
export async function settle(repos: RowRepos): Promise<void> {
  await flushDatastoreSync();
  await repos.remote.connect(cacheDir(repos.repoA), { instance: "A" })
    .pushChanged();
  await repos.remote.connect(cacheDir(repos.repoB), { instance: "B" })
    .pullChanged();
}

/** Where the op log and remote content stood before a use case ran. */
export interface Baseline {
  opCount: number;
  files: ReadonlyMap<string, Uint8Array>;
  /** How many lock releases and gate exits had been recorded. */
  releaseCount: number;
}

/** Snapshots the op log length and remote content. */
export function baseline(repos: RowRepos): Baseline {
  return {
    opCount: repos.remote.ops().length,
    files: new Map(repos.remote.files()),
    releaseCount: repos.releases.length,
  };
}

/**
 * A's push, prepare, commit and pull ops since `base`, in order, with
 * `release` wherever one or more lock releases or gate exits came between
 * them. Pins how many pushes a composition makes and where they sit relative
 * to the lock (CLI) or sync gate (serve) they run under.
 */
export function syncOrder(repos: RowRepos, base: Baseline): string[] {
  const ops = repos.remote.ops();
  const releases = repos.releases.slice(base.releaseCount);
  const order: string[] = [];
  const release = () => {
    if (order.at(-1) !== "release") order.push("release");
  };
  let next = 0;
  for (let i = base.opCount; i <= ops.length; i++) {
    while (next < releases.length && releases[next] <= i) {
      release();
      next++;
    }
    if (i === ops.length) break;
    const op = ops[i];
    if (op.instance === "A" && op.op !== "markDirty") order.push(op.op);
  }
  return order;
}

/** What a use case did to the datastore, normalised for pinning. */
export interface Observation {
  /**
   * Instance A's sync operations, in order: `markDirty <path>` for a path
   * mark, `markDirty(bulk)` for a bare mark, and `<op>[<paths>]` or
   * `<op>[<paths> del <deleted>]` for push, prepare, commit and pull.
   */
  ops: string[];
  /** Remote keys the use case added, removed or rewrote, sorted. */
  remote: { added: string[]; removed: string[]; changed: string[] };
  /** The refusal message, for a row pinned as refused. */
  error?: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** The start-time stamp in an output file name. */
const OUTPUT_STAMP = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g;
/** The random suffix `access grant create` gives a grant's instance name. */
const GRANT_INSTANCE = /\bgrant-[0-9a-f]{8}\b/g;

/** Replaces per-run ids, names and timestamps in a path or message. */
export function normalisePath(repos: RowRepos, path: string): string {
  return path
    .replaceAll(repos.modelType.normalized, "<type>")
    .replace(UUID, "<id>")
    .replace(OUTPUT_STAMP, "<time>")
    .replace(GRANT_INSTANCE, "grant-<suffix>");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Observes what happened on the remote since `base`. */
export function observe(repos: RowRepos, base: Baseline): Observation {
  const norm = (path: string) => normalisePath(repos, path);
  const ops = repos.remote.ops().slice(base.opCount)
    .filter((op) => op.instance === "A")
    .map((op) => {
      if (op.op === "markDirty") {
        return op.bulk
          ? "markDirty(bulk)"
          : `markDirty ${op.paths.map(norm).join(",")}`;
      }
      const deleted = op.deleted.length > 0 ? ` del ${op.deleted.length}` : "";
      return `${op.op}[${op.paths.length}${deleted}]`;
    });
  const after = repos.remote.files();
  const added: string[] = [];
  const changed: string[] = [];
  for (const [key, bytes] of after) {
    const before = base.files.get(key);
    if (!before) added.push(norm(key));
    else if (!sameBytes(before, bytes)) changed.push(norm(key));
  }
  const removed = [...base.files.keys()].filter((key) => !after.has(key))
    .map(norm);
  return {
    ops,
    remote: {
      added: added.sort(),
      removed: removed.sort(),
      changed: changed.sort(),
    },
  };
}

/** The one part of the root command the rows use. */
interface CliRoot {
  parse(args: string[]): Promise<unknown>;
}

let cliRoot: CliRoot | undefined;

// The root carries the global types and the `--json` global option that
// `src/cli/mod.ts` registers; without the types, `model create` and the
// edit commands fail to parse.
function root(): CliRoot {
  cliRoot ??= new Command()
    .name("swamp")
    .globalType("model_name", new ModelNameType())
    .globalType("model_type", new ModelTypeType())
    .globalType("workflow_name", new WorkflowNameType())
    .globalOption("--json", "Output in JSON format (non-interactive)")
    .noExit()
    .throwErrors()
    .command("access", accessCommand)
    .command("data", dataCommand)
    .command("datastore", datastoreCommand)
    .command("extension", extensionCommand)
    .command("model", modelCommand)
    .command("run", runCommand)
    .command("vault", vaultCommand)
    .command("worker", workerCommand)
    .command("workflow", workflowCommand);
  return cliRoot;
}

/**
 * Replaces `Deno.stdin` for `fn` with a non-terminal stream of `content`,
 * as a piped `swamp model edit < file` sees it. Without it, a non-TTY test
 * stdin sends the edit commands down the editor path.
 */
export async function withStdin<T>(
  content: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const stdin = Deno.stdin as unknown as Record<string, unknown>;
  const keys = ["isTerminal", "readable"];
  const saved = keys.map((key) =>
    [key, Object.getOwnPropertyDescriptor(stdin, key)] as const
  );
  Object.defineProperty(stdin, "isTerminal", {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(stdin, "readable", {
    configurable: true,
    get: () => new Blob(content === null ? [] : [content]).stream(),
  });
  try {
    return await fn();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(stdin, key, descriptor);
      else delete stdin[key];
    }
  }
}

/** A CLI invocation: argv after `swamp`, and optional piped stdin. */
export interface CliInvocation {
  args: string[];
  stdin?: string;
}

/**
 * Parses the real command in-process, then flushes registered syncs as
 * `src/cli/mod.ts` does at teardown, or best-effort when the command threw,
 * as its error path does. Returns what the command logged to stdout.
 * Asserts the command left `Deno.exitCode` unchanged.
 */
export async function runCli(invocation: CliInvocation): Promise<string[]> {
  const stdout: string[] = [];
  const originalLog = console.log;
  const previousExitCode = Deno.exitCode;
  Deno.exitCode = 0;
  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  };
  try {
    const parse = () => root().parse(invocation.args);
    try {
      if (invocation.stdin !== undefined) {
        await withStdin(invocation.stdin, parse);
      } else {
        await parse();
      }
    } catch (error) {
      try {
        await flushDatastoreSync();
      } catch {
        // Best effort, as mod.ts: the command's error takes precedence.
      }
      throw error;
    }
    await flushDatastoreSync();
    assertEquals(
      Deno.exitCode,
      0,
      `swamp ${invocation.args.join(" ")} set a failing exit code`,
    );
  } finally {
    console.log = originalLog;
    Deno.exitCode = previousExitCode;
  }
  return stdout;
}

/**
 * Parses the real command in-process and returns the error it threw, then
 * flushes registered syncs best-effort, as `src/cli/mod.ts` does when a
 * command fails. Fails when the command resolved. What the command logged
 * to stdout is appended to `stdout` when given.
 */
export async function runCliRejecting(
  invocation: CliInvocation,
  stdout?: string[],
): Promise<unknown> {
  const originalLog = console.log;
  const previousExitCode = Deno.exitCode;
  console.log = (...args: unknown[]) => {
    stdout?.push(args.map(String).join(" "));
  };
  try {
    try {
      await root().parse(invocation.args);
    } catch (error) {
      try {
        await flushDatastoreSync();
      } catch {
        // Best effort, as mod.ts: the command's error takes precedence.
      }
      return error;
    }
    throw new Error(`swamp ${invocation.args.join(" ")} did not fail`);
  } finally {
    console.log = originalLog;
    Deno.exitCode = previousExitCode;
  }
}

/** A serve request type and payload. */
export interface ServeInvocation {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Builds serve's connection context over A: the shared sync service, a real
 * sync gate, an active run registry, and the managed definitions dir under
 * `managedConfig`.
 */
export function serveCtx(
  repos: RowRepos,
  options: { activeRunRegistry?: ActiveRunRegistry } = {},
): ConnectionContext {
  const managed = repos.a.marker?.datastore?.managedConfig === true;
  return createServeCtx(repos.serveRepo, undefined, {
    syncService: repos.a.syncService,
    syncGate: new ObservedSyncGate(repos),
    activeRunRegistry: options.activeRunRegistry ?? new ActiveRunRegistry(),
    vaultsDir: repos.a.vaultsDir,
    ...(managed
      ? {
        managedDefinitionsDir: join(
          repos.a.datastoreResolver.resolvePath("config"),
          "models",
        ),
      }
      : {}),
  });
}

/**
 * Serve's real sync gate (`createSyncGate` builds a plain
 * {@link ReadWriteLock}), recording each exit in {@link RowRepos.releases}.
 */
export class ObservedSyncGate extends ReadWriteLock {
  readonly #repos: RowRepos;

  constructor(repos: RowRepos) {
    super();
    this.#repos = repos;
  }

  override release(): void {
    super.release();
    this.#repos.releases.push(this.#repos.remote.ops().length);
  }

  override releaseShared(): void {
    super.releaseShared();
    this.#repos.releases.push(this.#repos.remote.ops().length);
  }
}

/** Sends one request through `handleMessage`; asserts it did not fail. */
export async function runServe(
  ctx: ConnectionContext,
  invocation: ServeInvocation,
): Promise<Frame[]> {
  const frames = await sendRequest(ctx, {
    type: invocation.type,
    id: crypto.randomUUID(),
    payload: invocation.payload,
  });
  assertEquals(
    errorFrame(frames)?.error,
    undefined,
    `serve ${invocation.type} failed`,
  );
  return frames;
}

/**
 * One use case. `seed` runs before the settle step and its result reaches
 * the invocation builders; a `null` builder means the use case has no entry
 * point in that composition.
 */
export interface UseCaseRow<S = void> {
  name: string;
  options?: RowRepoOptions;
  /**
   * Skip the settle step, for a row whose seed is the very change the use
   * case publishes.
   */
  noSettle?: boolean;
  /** The CLI is expected to refuse: its error message is observed. */
  refuses?: boolean;
  /**
   * The use case marks paths from parallel writes, so the order of each run
   * of consecutive path marks is filesystem timing, not behaviour: compare
   * those runs sorted. Their position among other ops stays pinned.
   */
  parallelMarks?: boolean;
  /**
   * Marks the composition makes outside any use case's unit of work (hand
   * marks pinned in `PINNED_MARK_CALL_SITES`), as observed op strings. The
   * hook-identity check removes them before comparing the remaining marks
   * with what the use cases' units staged. Each entry names its pinned site.
   */
  outsideUseCase?: Partial<Record<Composition, string[]>>;
  /**
   * The composition runs in one root unit of work (`runInRootUnitOfWork`,
   * swamp-club#3032). The harness then also checks that the root staged every
   * mark the row made, and that {@link syncOrder} matches the row's pin.
   */
  rootUnit?: Partial<Record<Composition, true>>;
  /**
   * {@link syncOrder} for each composition switched to a root unit, recorded
   * from the composition before it adopted the root, so adopting it cannot
   * move a push across a lock release or gate exit. A composition not yet
   * in a root unit is checked against its pin too, so the pin is recorded
   * from the code before the switch.
   */
  syncOrder?: Partial<Record<Composition, string[]>>;
  seed?: (repos: RowRepos, composition: Composition) => Promise<S>;
  cli: ((repos: RowRepos, seed: S) => CliInvocation) | null;
  serve: ((repos: RowRepos, seed: S) => ServeInvocation) | null;
  /** Serve context overrides, for rows that own the active run registry. */
  serveCtx?: (seed: S) => { activeRunRegistry?: ActiveRunRegistry };
  /** Asserts the use case did its local work, after it ran. */
  verify?: (
    repos: RowRepos,
    seed: S,
    composition: Composition,
  ) => Promise<void>;
}

/** A row with its seed type erased, so rows of any seed type share a table. */
export type AnyRow = UseCaseRow<unknown>;

/** Erases a row's seed type; the seed only ever flows back into the row. */
export function row<S>(definition: UseCaseRow<S>): AnyRow {
  return definition as unknown as AnyRow;
}

/** A row's pinned observations; `null` where the composition has no entry. */
export interface PinnedRow {
  cli: Observation | null;
  serve: Observation | null;
}

/** Runs one row through one composition and observes it. */
export async function runRow<S>(
  row: UseCaseRow<S>,
  composition: Composition,
): Promise<Observation> {
  let observation: Observation | undefined;
  await withRowRepos(row.options ?? {}, async (repos) => {
    const seed = row.seed ? await row.seed(repos, composition) : undefined as S;
    if (!row.noSettle) await settle(repos);
    // Seeds run before the capture on purpose: they are setup, not the use
    // case under test, and run with production units.
    let units: CapturedUnit[] = [];
    let base: Baseline;
    if (composition === "cli") {
      base = baseline(repos);
      let error: string | undefined;
      units = await captureUnits(async () => {
        try {
          await runCli(row.cli!(repos, seed));
        } catch (caught) {
          if (!row.refuses) throw caught;
          error = caught instanceof Error ? caught.message : String(caught);
        }
      });
      observation = observe(repos, base);
      if (row.refuses) {
        assertEquals(typeof error, "string", `${row.name} did not refuse`);
        observation.error = normalisePath(repos, error!);
      }
    } else {
      const ctx = serveCtx(repos, row.serveCtx?.(seed));
      base = baseline(repos);
      units = await captureUnits(async () => {
        await runServe(ctx, row.serve!(repos, seed));
      });
      observation = observe(repos, base);
    }
    assertUnitsStagedTheirMarks(row, composition, repos, units, observation);
    if (row.rootUnit?.[composition]) {
      assertRootUnit(
        row,
        composition,
        repos,
        units,
        observation,
        syncOrder(repos, base),
      );
    } else if (row.syncOrder?.[composition] !== undefined) {
      // Pinned ahead of the composition adopting a root unit, so the pin is
      // checked against the code it was recorded from.
      assertEquals(
        syncOrder(repos, base),
        row.syncOrder[composition],
        `${row.name} (${composition}): pushes moved relative to lock ` +
          "release or gate exit",
      );
    }
    await row.verify?.(repos, seed, composition);
  });
  if (row.parallelMarks) sortPathMarkRuns(observation!.ops);
  return observation!;
}

/** A unit of work opened during a row, with the role production gave it. */
export interface CapturedUnit {
  unit: UnitOfWork;
  role: BoundUnitOfWorkOptions["role"];
}

/**
 * Runs `fn` with every repository-bound unit of work built in reject mode,
 * so a change staged after its unit ended fails the row, and returns the
 * units opened, in opening order. The factory receives the exact hook, flush
 * and parent production chose, so a unit bound to the wrong hook collects
 * nothing and fails the comparison below, and children still roll up.
 */
export async function captureUnits(
  fn: () => Promise<void>,
): Promise<CapturedUnit[]> {
  const units: CapturedUnit[] = [];
  const dispose = useUnitOfWorkFactoryForTesting((markDirty, options) => {
    const unit = createLegacyUnitOfWork(markDirty, {
      flush: options.flush,
      parent: options.parent,
      afterCommit: "reject",
    });
    units.push({ unit, role: options.role });
    return unit;
  });
  try {
    // A hooked write from production code that takes signalChange's hook
    // fallback fails the row (swamp-club#3056).
    await withUnscopedWriteGuard(fn);
  } finally {
    dispose();
  }
  return units;
}

/** The observed op string a staged change causes, or undefined if none. */
function markFor(
  repos: RowRepos,
  change: ReturnType<UnitOfWork["staged"]>[number],
): string | undefined {
  if (change.kind === "bulk") return "markDirty(bulk)";
  const rel = cacheRelativeMarkPath(
    change.path,
    cacheDir(repos.repoA),
    repos.repoA,
  );
  return rel === undefined
    ? undefined
    : `markDirty ${normalisePath(repos, rel)}`;
}

/** The op strings a unit's staged changes cause, in staging order. */
function marksOf(repos: RowRepos, unit: UnitOfWork): string[] {
  return unit.staged().map((change) => markFor(repos, change)).filter(
    (mark): mark is string => mark !== undefined,
  );
}

/**
 * The bound use-case units no other use-case unit contains. A nested use
 * case's unit is a child that rolls its changes up into its parent
 * (swamp-club#3032), so counting it as well would count its marks twice.
 */
function outermostUseCaseUnits(
  units: readonly CapturedUnit[],
): UnitOfWork[] {
  const useCases = new Set(
    units.filter((captured) => captured.role === "use-case").map((captured) =>
      captured.unit
    ),
  );
  const nested = (unit: UnitOfWork): boolean => {
    for (
      let parent = legacyUnitOfWorkParent(unit);
      parent !== undefined;
      parent = legacyUnitOfWorkParent(parent)
    ) {
      if (useCases.has(parent)) return true;
    }
    return false;
  };
  return [...useCases].filter((unit) =>
    legacyUnitOfWorkTarget(unit) !== undefined && !nested(unit)
  );
}

/**
 * Hook identity (swamp-club#3025): every mark the row made inside a use
 * case was staged by a unit of work the use case opened, and each unit's
 * changes reached the remote in the order it staged them. Marks the row
 * declares in `outsideUseCase` are removed first, and each must occur.
 */
function assertUnitsStagedTheirMarks(
  row: Pick<AnyRow, "name" | "outsideUseCase" | "parallelMarks">,
  composition: Composition,
  repos: RowRepos,
  units: readonly CapturedUnit[],
  observation: Observation,
): void {
  const inUseCase = observation.ops.filter((op) => op.startsWith("markDirty"));
  for (const outside of row.outsideUseCase?.[composition] ?? []) {
    const at = inUseCase.indexOf(outside);
    assertEquals(
      at >= 0,
      true,
      `${row.name} (${composition}): declared outside-use-case mark ` +
        `"${outside}" was not observed`,
    );
    inUseCase.splice(at, 1);
  }
  const perUnit = outermostUseCaseUnits(units).map((unit) =>
    marksOf(repos, unit)
  );
  assertEquals(
    perUnit.flat().sort(),
    [...inUseCase].sort(),
    `${row.name} (${composition}): marks staged by the use cases' units ` +
      "differ from the marks the use cases made",
  );
  if (row.parallelMarks) return;
  for (const marks of perUnit) {
    let from = 0;
    for (const mark of marks) {
      const at = inUseCase.indexOf(mark, from);
      assertEquals(
        at >= 0,
        true,
        `${row.name} (${composition}): unit staged "${mark}" out of order`,
      );
      from = at + 1;
    }
  }
}

/**
 * Root unit (swamp-club#3032): the composition opened exactly one root unit;
 * it staged every mark the row made, use case or not, in the order they
 * reached the remote; and the row's pushes sit where its pinned
 * {@link syncOrder} says relative to lock releases and gate exits.
 */
export function assertRootUnit(
  row: Pick<AnyRow, "name" | "parallelMarks" | "syncOrder">,
  composition: Composition,
  repos: RowRepos,
  units: readonly CapturedUnit[],
  observation: Observation,
  order: readonly string[],
): void {
  const label = `${row.name} (${composition})`;
  const roots = units.filter((captured) =>
    captured.role === "root" &&
    legacyUnitOfWorkParent(captured.unit) === undefined
  );
  assertEquals(roots.length, 1, `${label}: expected exactly one root unit`);
  const staged = marksOf(repos, roots[0].unit);
  const observed = observation.ops.filter((op) => op.startsWith("markDirty"));
  if (row.parallelMarks) {
    assertEquals(
      [...staged].sort(),
      [...observed].sort(),
      `${label}: the root unit did not stage every mark the row made`,
    );
  } else {
    assertEquals(
      staged,
      observed,
      `${label}: the root unit did not stage every mark the row made, in order`,
    );
  }
  const pinned = row.syncOrder?.[composition];
  assertEquals(
    pinned !== undefined,
    true,
    `${label}: a root-unit row must pin syncOrder, recorded before the ` +
      "composition adopted the root",
  );
  assertEquals(
    [...order],
    pinned,
    `${label}: pushes moved relative to lock release or gate exit`,
  );
}

/** Sorts each run of consecutive path marks in place. */
function sortPathMarkRuns(ops: string[]): void {
  const isPathMark = (op: string) => op.startsWith("markDirty ");
  for (let start = 0; start < ops.length;) {
    if (!isPathMark(ops[start])) {
      start++;
      continue;
    }
    let end = start;
    while (end < ops.length && isPathMark(ops[end])) end++;
    ops.splice(start, end - start, ...ops.slice(start, end).sort());
    start = end;
  }
}

/**
 * Registers one step per row and composition, comparing each observation
 * with its pinned entry. Every row must have a pinned entry, and a
 * composition is pinned `null` exactly when the row has no entry point
 * there.
 */
async function checkEachRow(
  t: Deno.TestContext,
  rows: AnyRow[],
  expected: Record<string, PinnedRow>,
): Promise<void> {
  assertEquals(
    rows.map((row) => row.name).sort(),
    Object.keys(expected).sort(),
    "every row has exactly one pinned entry",
  );
  for (const row of rows) {
    for (const composition of ["cli", "serve"] as const) {
      const pinned = expected[row.name][composition];
      await t.step(`${row.name} (${composition})`, async () => {
        assertEquals(
          row[composition] === null,
          pinned === null,
          `${row.name} is pinned ${
            pinned === null ? "without" : "with"
          } a ${composition} entry point`,
        );
        if (pinned === null) return;
        const observed = await withMockedEnv(
          UNSET_ENV,
          () => runRow(row, composition),
        );
        assertEquals(observed, pinned);
      });
    }
  }
}

/**
 * Environment the rows read as unset, so a developer's shell (a serve URL,
 * a repo dir, a datastore override) cannot redirect a CLI row.
 */
export const UNSET_ENV: Record<string, undefined> = {
  SWAMP_SERVE_URL: undefined,
  SWAMP_SERVER_URL: undefined,
  SWAMP_SERVER_TOKEN: undefined,
  SWAMP_SERVER_TOKEN_FILE: undefined,
  SWAMP_REPO_DIR: undefined,
  SWAMP_DATASTORE: undefined,
  SWAMP_DATASTORES_DIR: undefined,
  SWAMP_MODELS_DIR: undefined,
  SWAMP_WORKFLOWS_DIR: undefined,
  SWAMP_VAULTS_DIR: undefined,
  SWAMP_EXTENSIONS_DIR: undefined,
  SWAMP_REPORTS_DIR: undefined,
  SWAMP_WEBHOOKS_DIR: undefined,
};

function refuseFetch(request: Request): Response {
  throw new Error(
    `unexpected network request: ${request.method} ${request.url}`,
  );
}

/**
 * Registers one step per row and composition, comparing each observation
 * with its pinned entry, with every network request refused: no row may
 * reach a registry, and a request a row swallowed still fails the test.
 */
export async function checkRows(
  t: Deno.TestContext,
  rows: AnyRow[],
  expected: Record<string, PinnedRow>,
): Promise<void> {
  const { calls } = await withMockedFetch(
    refuseFetch,
    () => checkEachRow(t, rows, expected),
  );
  assertEquals(calls.map((call) => `${call.method} ${call.url}`), []);
}
