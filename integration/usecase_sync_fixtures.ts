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
 * each row gets its own remote and two per-run datastore types, A (the use
 * case's repo) and B (a peer that settles seeds), so op logs never mix
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
import { registerCompletionTypes } from "../src/cli/completion_types.ts";
import { accessCommand } from "../src/cli/commands/access.ts";
import { dataCommand } from "../src/cli/commands/data.ts";
import { datastoreCommand } from "../src/cli/commands/datastore.ts";
import { doctorCommand } from "../src/cli/commands/doctor.ts";
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

export type Composition = "cli" | "serve";

export type UnlockedRepo = Awaited<
  ReturnType<typeof requireInitializedRepoUnlocked>
>;

export interface RowRepoOptions {
  managedConfig?: boolean;
  remote?: InMemoryRemoteOptions;
  datastoreControlPlane?: boolean;
}

export interface RowRepos {
  remote: InMemoryRemote;
  repoA: string;
  repoB: string;
  modelType: ModelType;
  a: UnlockedRepo;
  serveRepo: ServeRepo;
  releases: number[];
}

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

export function cacheDir(repoDir: string): string {
  return join(repoDir, ".test-cache");
}

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
  const datastoreControlPlane = options.datastoreControlPlane
    ? { datastoreControlPlaneStore: () => remote.datastoreControlPlaneStore!() }
    : {};
  const typeA = registerTestDatastoreType({
    connect: (cache) => remote.connect(cache, { instance: "A" }),
    ...datastoreControlPlane,
  }, { onLockRelease: () => releases.push(remote.ops().length) });
  const typeB = registerTestDatastoreType({
    connect: (cache) => remote.connect(cache, { instance: "B" }),
    ...datastoreControlPlane,
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
  // the CLI resolves a --repo-dir through a symlink and the macOS temp dir is
  // one, so the fixture spells its repos that way
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-usecase-sync-" }),
  );
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
    // a hooked write from production code that takes signalChange's hook
    // fallback fails the test, seeds included
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
 * without it a seed never reaches the remote, and a delete shows as deleting
 * nothing
 */
export async function settle(repos: RowRepos): Promise<void> {
  await flushDatastoreSync();
  await repos.remote.connect(cacheDir(repos.repoA), { instance: "A" })
    .pushChanged();
  await repos.remote.connect(cacheDir(repos.repoB), { instance: "B" })
    .pullChanged();
}

export interface Baseline {
  opCount: number;
  files: ReadonlyMap<string, Uint8Array>;
  releaseCount: number;
}

export function baseline(repos: RowRepos): Baseline {
  return {
    opCount: repos.remote.ops().length,
    files: new Map(repos.remote.files()),
    releaseCount: repos.releases.length,
  };
}

/**
 * pins how many pushes a composition makes and where they sit relative to the
 * lock (CLI) or sync gate (serve) they run under
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

export interface Observation {
  /**
   * Instance A's sync operations, in order: `markDirty <path>` for a path
   * mark, `markDirty(bulk)` for a bare mark, and `<op>[<paths>]` or
   * `<op>[<paths> del <deleted>]` for push, prepare, commit and pull.
   */
  ops: string[];
  remote: { added: string[]; removed: string[]; changed: string[] };
  error?: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const OUTPUT_STAMP = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g;
const GRANT_INSTANCE = /\bgrant-[0-9a-f]{8}\b/g;

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

interface CliRoot {
  parse(args: string[]): Promise<unknown>;
}

let cliRoot: CliRoot | undefined;

// The root carries the global types and the `--json` global option that
// `src/cli/mod.ts` registers; without the types, `model create` and the
// edit commands fail to parse.
function root(): CliRoot {
  cliRoot ??= registerCompletionTypes(new Command())
    .name("swamp")
    .globalOption("--json", "Output in JSON format (non-interactive)")
    .noExit()
    .throwErrors()
    .command("access", accessCommand)
    .command("data", dataCommand)
    .command("datastore", datastoreCommand)
    .command("doctor", doctorCommand)
    .command("extension", extensionCommand)
    .command("model", modelCommand)
    .command("run", runCommand)
    .command("vault", vaultCommand)
    .command("worker", workerCommand)
    .command("workflow", workflowCommand);
  return cliRoot;
}

/**
 * a non-TTY test stdin would send the edit commands down the editor path, so
 * this gives a non-terminal stream of `content` as piped `swamp model edit <
 * file` sees
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

export interface CliInvocation {
  args: string[];
  stdin?: string;
}

export async function runCli(invocation: CliInvocation): Promise<string[]> {
  if (outsideSeedRoot !== undefined) {
    const outside = outsideSeedRoot;
    return await outside(() => runCliHere(invocation));
  }
  return await runCliHere(invocation);
}

/**
 * runs a seed's own CLI and serve calls outside the root unit a v3 row opens
 * around its seed, since in production a command or request never runs inside
 * another one's root
 */
let outsideSeedRoot: (<T>(fn: () => Promise<T>) => Promise<T>) | undefined;

export async function withOutsideSeedRoot<T>(
  outside: <U>(fn: () => Promise<U>) => Promise<U>,
  fn: () => Promise<T>,
): Promise<T> {
  outsideSeedRoot = outside;
  try {
    return await fn();
  } finally {
    outsideSeedRoot = undefined;
  }
}

async function runCliHere(invocation: CliInvocation): Promise<string[]> {
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

export interface CapturedCli {
  readonly stdout: string[];
  readonly error: unknown;
  readonly exitCode: number;
}

export async function runCliCapturing(
  invocation: CliInvocation,
): Promise<CapturedCli> {
  const stdout: string[] = [];
  const originalLog = console.log;
  const originalInfo = console.info;
  const previousExitCode = Deno.exitCode;
  Deno.exitCode = 0;
  const capture = (...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  };
  console.log = capture;
  console.info = capture;
  let error: unknown;
  let exitCode = 0;
  try {
    await root().parse(invocation.args);
  } catch (thrown) {
    error = thrown;
  } finally {
    try {
      await flushDatastoreSync();
    } catch {
      // Best effort, as mod.ts: the command's error takes precedence.
    }
    exitCode = Deno.exitCode;
    console.log = originalLog;
    console.info = originalInfo;
    Deno.exitCode = previousExitCode;
  }
  return { stdout, error, exitCode };
}

export interface ServeInvocation {
  type: string;
  payload: Record<string, unknown>;
}

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

export async function runServe(
  ctx: ConnectionContext,
  invocation: ServeInvocation,
): Promise<Frame[]> {
  if (outsideSeedRoot !== undefined) {
    const outside = outsideSeedRoot;
    return await outside(() => runServeHere(ctx, invocation));
  }
  return await runServeHere(ctx, invocation);
}

async function runServeHere(
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

export interface UseCaseRow<S = void> {
  name: string;
  options?: RowRepoOptions;
  noSettle?: boolean;
  refuses?: boolean;
  /**
   * parallel writes mark paths in filesystem order, so compare each run of
   * consecutive path marks sorted; their position among other ops stays pinned
   */
  parallelMarks?: boolean;
  /**
   * marks made outside any use case's unit of work, removed before the
   * hook-identity comparison; each entry names its pinned site
   */
  outsideUseCase?: Partial<Record<Composition, string[]>>;
  rootUnit?: Partial<Record<Composition, true>>;
  /**
   * more than one only where each run is its own root, e.g. the managed
   * lockfile transaction opens one per outermost run, so a CLI extension rm
   * opens two
   */
  rootUnits?: Partial<Record<Composition, number>>;
  /**
   * recorded before the composition adopted the root, so adopting it cannot
   * move a push across a lock release or gate exit; compositions not yet in a
   * root unit are checked too
   */
  syncOrder?: Partial<Record<Composition, string[]>>;
  seed?: (repos: RowRepos, composition: Composition) => Promise<S>;
  cli: ((repos: RowRepos, seed: S) => CliInvocation) | null;
  serve: ((repos: RowRepos, seed: S) => ServeInvocation) | null;
  serveCtx?: (seed: S) => { activeRunRegistry?: ActiveRunRegistry };
  verify?: (
    repos: RowRepos,
    seed: S,
    composition: Composition,
  ) => Promise<void>;
}

export type AnyRow = UseCaseRow<unknown>;

export function row<S>(definition: UseCaseRow<S>): AnyRow {
  return definition as unknown as AnyRow;
}

export interface PinnedRow {
  cli: Observation | null;
  serve: Observation | null;
}

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

export interface CapturedUnit {
  unit: UnitOfWork;
  role: BoundUnitOfWorkOptions["role"];
}

/**
 * reject mode makes a change staged after its unit ended fail the row; the
 * factory gets the hook, flush and parent production chose, so a wrongly bound
 * unit collects nothing
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
    // a hooked write from production code that falls back to signalChange's
    // hook fails the row
    await withUnscopedWriteGuard(fn);
  } finally {
    dispose();
  }
  return units;
}

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

function marksOf(repos: RowRepos, unit: UnitOfWork): string[] {
  return unit.staged().map((change) => markFor(repos, change)).filter(
    (mark): mark is string => mark !== undefined,
  );
}

/**
 * a nested use case's unit rolls its changes up into its parent, so counting it
 * too would count its marks twice
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

export function assertRootUnit(
  row: Pick<AnyRow, "name" | "parallelMarks" | "syncOrder" | "rootUnits">,
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
  const expectedRoots = row.rootUnits?.[composition] ?? 1;
  assertEquals(
    roots.length,
    expectedRoots,
    expectedRoots === 1
      ? `${label}: expected exactly one root unit`
      : `${label}: expected ${expectedRoots} root units`,
  );
  const staged = roots.flatMap((captured) => marksOf(repos, captured.unit));
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
 * a read run's push stages each report version and latest marker again before
 * uploading
 */
export const READ_RUN_PUBLISH_MARKS = [
  "markDirty data/<type>/<id>/report-swamp-method-summary-json/1",
  "markDirty data/<type>/<id>/report-swamp-method-summary-json/latest",
  "markDirty data/<type>/<id>/report-swamp-method-summary/1",
  "markDirty data/<type>/<id>/report-swamp-method-summary/latest",
];

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
 * a developer's shell (serve URL, repo dir, datastore override) must not
 * redirect a CLI row
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
  SWAMP_BEHAVIORS_DIR: undefined,
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
 * every network request is refused, so a request a row swallowed still fails
 * the test
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
