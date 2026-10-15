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

// Indexing an extension source must not run its import in the command's
// isolate (swamp-club#3374). A source that exits, hangs, prints or throws
// at import is probed in a probe host process: the pass returns, healthy siblings are
// indexed, and a source that never finishes is recorded once instead of
// being retried by every command.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import { vaultKindAdapter } from "../src/domain/extensions/vault_kind_adapter.ts";
import { modelKindAdapter } from "../src/domain/extensions/model_kind_adapter.ts";
import type {
  BundleProber,
  BundleProbeRequest,
  BundleProbeResult,
} from "../src/domain/extensions/bundle_prober.ts";
import { ProcessBundleProber } from "../src/infrastructure/runtime/process_bundle_prober.ts";
import { ReconcileFromDiskService } from "../src/libswamp/extensions/reconcile_from_disk_service.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { vaultTypeRegistry } from "../src/domain/vaults/vault_type_registry.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";

import "../src/domain/models/models.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

type Behaviour = "healthy" | "exit" | "hang" | "print" | "throw";

const AT_IMPORT: Record<Behaviour, string> = {
  healthy: "",
  exit: "Deno.exit(3);",
  hang: "await new Promise(() => {});",
  print: 'console.log("HELLO FROM EXTENSION");',
  throw: 'throw new Error("boom at import");',
};

/**
 * A vault source that records, on the global of whichever isolate imports
 * it, that it ran — so a test can tell the main isolate never did.
 */
function vaultSource(type: string, marker: string, behaviour: Behaviour) {
  return `
(globalThis as Record<string, unknown>)[${JSON.stringify(marker)}] = true;
${AT_IMPORT[behaviour]}
export const vault = {
  type: ${JSON.stringify(type)},
  name: "probe test vault",
  description: "indexed by probe",
  createProvider: () => ({
    get: () => Promise.resolve("v"),
    put: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    getName: () => "probe-test",
  }),
};
`;
}

/**
 * Probes in a real probe host and counts probes per bundle. The hanging source
 * gets its own short timeout, so the others keep a generous one.
 */
class CountingProber implements BundleProber {
  readonly probed: string[] = [];
  releases = 0;
  private readonly patient = new ProcessBundleProber();
  private readonly impatient = new ProcessBundleProber({ timeoutMs: 500 });

  probe(request: BundleProbeRequest): Promise<BundleProbeResult> {
    this.probed.push(request.importUrl);
    return request.importUrl.includes("/hang.js")
      ? this.impatient.probe(request)
      : this.patient.probe(request);
  }

  async release(): Promise<void> {
    this.releases++;
    await this.patient.release();
    await this.impatient.release();
  }

  countFor(name: Behaviour): number {
    return this.probed.filter((url) => url.includes(`/${name}.js`)).length;
  }
}

interface Repo {
  repoDir: string;
  vaultsDir: string;
  id: string;
  catalog: ExtensionCatalogStore;
  repository: ExtensionRepository;
  lockfileRepository: LockfileRepository;
  prober: CountingProber;
  typeOf(name: Behaviour): string;
  write(name: Behaviour, suffix?: string): Promise<string>;
  ranInMainIsolate(): string[];
}

async function withRepo(fn: (repo: Repo) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_3374_probe_" });
  const vaultsDir = join(repoDir, "extensions", "vaults");
  await ensureDir(join(repoDir, ".swamp"));
  await ensureDir(vaultsDir);
  const lockfilePath = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
  await ensureDir(join(repoDir, "extensions", "models"));
  await Deno.writeTextFile(lockfilePath, "{}");

  const id = crypto.randomUUID().slice(0, 8);
  const marker = (name: Behaviour) => `__swamp_3374_${id}_${name}`;
  const catalog = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "_extension_catalog.db"),
  );
  const lockfileRepository = await LockfileRepository.create(lockfilePath);
  const repository = new ExtensionRepository({
    catalog,
    lockfileRepository,
    repoRoot: repoDir,
  });
  const prober = new CountingProber();
  const repo: Repo = {
    repoDir,
    vaultsDir,
    id,
    catalog,
    repository,
    lockfileRepository,
    prober,
    typeOf: (name) => `@test/probe-${id}-${name}`,
    write: async (name, suffix = "") => {
      const path = join(vaultsDir, `${name}.ts`);
      await Deno.writeTextFile(
        path,
        vaultSource(repo.typeOf(name), marker(name), name) + suffix,
      );
      return path;
    },
    ranInMainIsolate: () =>
      (["healthy", "exit", "hang", "print", "throw"] as const).filter((name) =>
        (globalThis as Record<string, unknown>)[marker(name)] === true
      ),
  };
  // Anything the main isolate prints during a pass is a leak.
  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    printed.push(args.join(" "));
  };
  try {
    await fn(repo);
    assertEquals(printed, []);
  } finally {
    console.log = originalLog;
    prober.release();
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function reconcile(repo: Repo) {
  return new ReconcileFromDiskService({
    denoRuntime: testDenoRuntime,
    repository: repo.repository,
    lockfileRepository: repo.lockfileRepository,
    repoDir: repo.repoDir,
    bundleProber: repo.prober,
  }).execute();
}

function buildIndex(repo: Repo) {
  return new ExtensionLoader(
    testDenoRuntime,
    vaultKindAdapter,
    repo.repoDir,
    undefined,
    repo.repository,
    repo.prober,
  ).buildIndex(repo.vaultsDir, { indexOnly: true });
}

function stateOf(repo: Repo, path: string): string | undefined {
  return repo.catalog.findBySourcePath(path)?.state;
}

Deno.test("startup reconcile indexes sources that exit, hang, print or throw at import without running them in the main isolate", async () => {
  await withRepo(async (repo) => {
    const healthy = await repo.write("healthy");
    const exit = await repo.write("exit");
    const hang = await repo.write("hang");
    const print = await repo.write("print");
    const thrown = await repo.write("throw");

    await reconcile(repo);
    await buildIndex(repo);

    assertEquals(repo.ranInMainIsolate(), []);
    assertEquals(stateOf(repo, healthy), "Indexed");
    assertEquals(stateOf(repo, print), "Indexed");
    assertEquals(stateOf(repo, exit), "ValidationFailed");
    assertEquals(stateOf(repo, hang), "ValidationFailed");
    assertEquals(stateOf(repo, thrown), "BundleBuildFailed");

    // Indexed types are known but not loaded; failed ones are not listed.
    assertEquals(vaultTypeRegistry.has(repo.typeOf("healthy")), true);
    assertEquals(vaultTypeRegistry.has(repo.typeOf("print")), true);
    assertEquals(vaultTypeRegistry.get(repo.typeOf("healthy")), undefined);
    assertEquals(vaultTypeRegistry.has(repo.typeOf("exit")), false);
    assertEquals(vaultTypeRegistry.has(repo.typeOf("hang")), false);
  });
});

Deno.test("a source that hangs or exits at import is probed once, then left alone until it is edited", async () => {
  await withRepo(async (repo) => {
    await repo.write("healthy");
    await reconcile(repo);
    await buildIndex(repo);

    // Added after the catalog is populated, so only the warm stale-file
    // scan sees them.
    const hang = await repo.write("hang");
    const exit = await repo.write("exit");
    await buildIndex(repo);
    assertEquals(stateOf(repo, hang), "ValidationFailed");
    assertEquals(stateOf(repo, exit), "ValidationFailed");
    assertEquals(repo.prober.countFor("hang"), 1);
    assertEquals(repo.prober.countFor("exit"), 1);

    await buildIndex(repo);
    await buildIndex(repo);
    assertEquals(repo.prober.countFor("hang"), 1);
    assertEquals(repo.prober.countFor("exit"), 1);

    await repo.write("exit", "\n// edited\n");
    await buildIndex(repo);
    assertEquals(repo.prober.countFor("exit"), 2);
    assertEquals(repo.ranInMainIsolate(), []);
  });
});

Deno.test("an edited source is re-indexed by probe and stays a lazy type", async () => {
  await withRepo(async (repo) => {
    const print = await repo.write("print");
    await reconcile(repo);
    await buildIndex(repo);
    const before = repo.catalog.findBySourcePath(print)!.source_fingerprint;

    await repo.write("print", "\n// edited\n");
    await buildIndex(repo);

    const after = repo.catalog.findBySourcePath(print)!;
    assertEquals(after.state, "Indexed");
    assertEquals(after.source_fingerprint === before, false);
    assertEquals(after.type_normalized, repo.typeOf("print"));
    assertEquals(after.description, "indexed by probe");
    assertEquals(vaultTypeRegistry.has(repo.typeOf("print")), true);
    assertEquals(vaultTypeRegistry.get(repo.typeOf("print")), undefined);
    assertEquals(repo.ranInMainIsolate(), []);
  });
});

Deno.test("a new add-on to an already registered base type is indexed without being imported at index time", async () => {
  await withRepo(async (repo) => {
    await repo.write("healthy");
    await reconcile(repo);
    const modelsDir = join(repo.repoDir, "extensions", "models");
    const modelLoader = () =>
      new ExtensionLoader(
        testDenoRuntime,
        modelKindAdapter,
        repo.repoDir,
        undefined,
        repo.repository,
        repo.prober,
      ).buildIndex(modelsDir, { indexOnly: true });
    await modelLoader();

    // Added once the catalog is populated: the warm path used to attach it
    // to the built-in base type by importing it straight away.
    const marker = `__swamp_3374_${repo.id}_addon`;
    const addon = join(modelsDir, "addon.ts");
    await Deno.writeTextFile(
      addon,
      `
import { z } from "npm:zod@4";
(globalThis as Record<string, unknown>)[${JSON.stringify(marker)}] = true;
export const extension = {
  type: "command/shell",
  methods: [{
    probe_${repo.id.replaceAll("-", "_")}: {
      description: "probe",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`,
    );
    await modelLoader();

    const row = repo.catalog.findBySourcePath(addon);
    assertEquals(row?.kind, "extension");
    assertEquals(row?.extends_type, "command/shell");
    assertEquals(row?.state, "Indexed");
    assertEquals((globalThis as Record<string, unknown>)[marker], undefined);
  });
});

Deno.test("every index pass releases its prober, including a refresh of stale sources", async () => {
  await withRepo(async (repo) => {
    await repo.write("healthy");
    const loader = new ExtensionLoader(
      testDenoRuntime,
      vaultKindAdapter,
      repo.repoDir,
      undefined,
      repo.repository,
      repo.prober,
    );
    await reconcile(repo);
    assertEquals(repo.prober.releases, 1);
    await loader.buildIndex(repo.vaultsDir, { indexOnly: true });
    assertEquals(repo.prober.releases, 2);

    await repo.write("print");
    const changes = await loader.refreshStaleSources(repo.vaultsDir);
    assertEquals(changes?.failed, []);
    assertEquals(repo.prober.countFor("print"), 1);
    assertEquals(repo.prober.releases, 3);
    assertEquals(repo.ranInMainIsolate(), []);
  });
});
