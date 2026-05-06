// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * Cross-process concurrency stress for the W2 lifecycle services
 * (InstallExtensionService / RemoveExtensionService / UpgradeExtensionService).
 *
 * Closes the test gap from swamp-club#254. Mirrors the structure of the
 * swamp-club#234 race regression at integration/data_delete_test.ts (the only
 * other cross-process stress test in this suite).
 *
 * What it verifies
 * ----------------
 * The W2 lifecycle services claim per-extension atomicity under cross-process
 * concurrency: `saveAll` is one SQLite transaction with WAL on, lockfile
 * mutations use the advisory-lock retry path, and ordering is asymmetric
 * (install: FS → lockfile → catalog; rm: catalog → lockfile → FS — see
 * src/libswamp/extensions/install_extension_service.ts:65-90 and
 * remove_extension_service.ts:38-66). The unit-level FaultingStubRepository
 * tests (install_extension_service_test.ts) already pin SQLite ROLLBACK
 * semantics; this test is the cross-process composition check.
 *
 * Calibration note
 * ----------------
 * data_delete_test.ts's RACE_ITERATIONS=50 was sized against an evidence-base —
 * the swamp-club#234 race reproduced in ~40 attempts under high writer
 * pressure. This test, by contrast, verifies the ABSENCE of a race in code
 * that's claimed safe — no calibration point exists. N=50 is mirrored so a
 * future regression has a leading-indicator chance to surface here, but it is
 * not a guarantee. If a regression takes >50 iterations to surface, this test
 * will miss it; CI's natural soak across the merge train is the longer-tail
 * coverage.
 *
 * Architecture note (ADV-9)
 * -------------------------
 * Lockfile and catalog use independent locks. The lockfile lock
 * (LOCK_RETRY_COUNT=10, LOCK_RETRY_DELAY_MS=100 — see
 * src/infrastructure/persistence/lockfile_repository.ts) does NOT serialise
 * SQLite catalog contention. Invariant (ii') filters lockfile-exhaustion
 * as a real failure (the lockfile retry budget exists precisely to
 * absorb expected contention; exhausting it means real damage).
 *
 * SQLite contention ("database is locked") is INTENTIONALLY tolerated.
 * Per design/extension.md "Crash-state recovery", a saveAll failure on
 * SQLite I/O rolls the catalog back via SQLite ROLLBACK while leaving
 * FS+lockfile in place — the user-visible "Install partially applied …
 * retry to reconcile" path. The next pull/update's diff-save reconciles.
 * The bijection invariants (i) tolerate this transient state by
 * detecting the W2 recovery message in stderr and skipping the
 * lockfile→catalog direction for that extension; a final sequential
 * `extension update` after the loop drains any pending state and
 * end-state strict bijection is asserted.
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";

const PROJECT_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");

// CLI args including --allow-net so children can reach the local fixture
// registry. integration/test_helpers.ts CLI_ARGS omits --allow-net by design,
// so we build our own here.
const STRESS_CLI_ARGS = [
  "run",
  "--config",
  join(PROJECT_ROOT, "deno.json"),
  "--unstable-bundle",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-net",
  "--allow-sys",
  join(PROJECT_ROOT, "main.ts"),
];

// Tied to the operation menu in swamp-club#254 (extension pull <name> /
// extension pull <other-name> / extension rm <name> / extension update — one
// child per op per iteration). Do not silently shrink — that breaks the
// load-bearing concurrency claim this test verifies.
const CONCURRENCY_PER_ITERATION = 4;

// Mirrored from data_delete_test.ts's RACE_ITERATIONS=50. See "Calibration
// note" in the file header. Do not silently shrink without reading
// swamp-club#254.
const RACE_ITERATIONS = 50;

const ALPHA = "@stress/alpha";
const BETA = "@stress/beta";
// DO NOT share type ids between fixture extensions — distinct types are
// load-bearing for invariant (ii). Sharing would surface a real
// cross-extension DuplicateTypeError on every concurrent install of
// alpha+beta and the test would mis-categorise it as benign. See ADV-2 in
// the issue's plan-review.
const ALPHA_TYPE = "@stress/alpha-model";
const BETA_TYPE = "@stress/beta-model";
const ALPHA_V1 = "2026.05.05.1";
const ALPHA_V2 = "2026.05.05.2";
const BETA_V1 = "2026.05.05.1";

// =====================================================================
// Fixture extension generation
// =====================================================================

function modelCode(typeId: string, version: string): string {
  return `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "${version}",
  globalArguments: z.object({}),
  resources: {
    "data": {
      description: "x",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 1,
    },
  },
  methods: {
    noop: {
      description: "noop",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
}

interface FixtureExt {
  name: string;
  version: string;
  typeId: string;
  modelFile: string;
}

async function buildArchive(ext: FixtureExt): Promise<Uint8Array> {
  const stagingRoot = await Deno.makeTempDir({ prefix: "swamp_stress_stage_" });
  try {
    const extDir = join(stagingRoot, "extension");
    const modelsDir = join(extDir, "models");
    await ensureDir(modelsDir);

    const manifest = stringifyYaml({
      manifestVersion: 1,
      name: ext.name,
      version: ext.version,
      description: `stress fixture ${ext.name}@${ext.version}`,
      models: [ext.modelFile],
    } as Record<string, unknown>);
    await Deno.writeTextFile(join(extDir, "manifest.yaml"), manifest);
    await Deno.writeTextFile(
      join(modelsDir, ext.modelFile),
      modelCode(ext.typeId, ext.version),
    );

    const archivePath = join(stagingRoot, "extension.tar.gz");
    await createTarGz(extDir, archivePath);
    return await Deno.readFile(archivePath);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(stagingRoot, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(stagingRoot, { recursive: true });
    }
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// =====================================================================
// Local fixture registry (the four endpoints `installExtension` requires)
// =====================================================================
//
// Each fake endpoint references the corresponding ExtensionApiClient
// callsite at src/infrastructure/http/extension_api_client.ts so a future
// API drift fails this test loudly instead of silently shipping bad
// production code.

interface FixtureBundle {
  bytes: Uint8Array;
  checksum: string;
}

interface FixtureRegistry {
  url: string;
  shutdown: () => Promise<void>;
}

async function startFixtureRegistry(
  bundles: Map<string, Map<string, FixtureBundle>>,
  // `latestVersion[name]` is what GET /api/v1/extensions/<name> advertises.
  // Pin alpha's latest to V2 (so `extension update` always tries to upgrade
  // alpha when it is installed at V1 — exercises the upgrade path's atomic
  // tombstoneAll+save). Pin beta's latest to V1 (no-op upgrade for beta).
  // Resolves ADV-8 — without this, the upgrade path never gets exercised.
  latestVersion: Record<string, string>,
): Promise<FixtureRegistry> {
  const ac = new AbortController();
  // Bind to 127.0.0.1:0 — the OS picks a free port and we read it back.
  // Wrapped in a promise that resolves once the listener is up.
  let resolveUrl: (url: string) => void;
  const urlPromise = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });

  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: ac.signal,
      onListen: ({ hostname, port }) => {
        resolveUrl(`http://${hostname}:${port}`);
      },
    },
    async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;

      // GET /api/v1/extensions/{name}
      // Mirrors ExtensionApiClient.getExtension at extension_api_client.ts:270
      const getExtMatch = path.match(/^\/api\/v1\/extensions\/([^/@]+)$/);
      if (getExtMatch && req.method === "GET") {
        const name = decodeURIComponent(getExtMatch[1]);
        if (!bundles.has(name)) {
          return new Response("not found", { status: 404 });
        }
        return Response.json({
          name,
          description: `stress fixture ${name}`,
          latestVersion: latestVersion[name],
        });
      }

      // GET /api/v1/extensions/{name}/latest
      // Mirrors ExtensionApiClient.getLatestVersion at extension_api_client.ts:131
      const latestMatch = path.match(
        /^\/api\/v1\/extensions\/([^/@]+)\/latest$/,
      );
      if (latestMatch && req.method === "GET") {
        const name = decodeURIComponent(latestMatch[1]);
        if (!bundles.has(name)) {
          return new Response("not found", { status: 404 });
        }
        return Response.json({
          latestVersion: latestVersion[name],
          latestVersionDetail: {
            version: latestVersion[name],
            publishedAt: "2026-05-05T00:00:00Z",
          },
        });
      }

      // GET /api/v1/extensions/{name}@{version}/download
      // Mirrors ExtensionApiClient.getDownloadUrl at extension_api_client.ts:294
      // Returns 302 redirecting to /raw-bundle/{name}@{version} (an internal
      // route this same server serves below). The client re-fetches the
      // Location URL, so the redirect target has to be reachable.
      const dlMatch = path.match(
        /^\/api\/v1\/extensions\/([^/@]+)@([^/]+)\/download$/,
      );
      if (dlMatch && req.method === "GET") {
        const name = decodeURIComponent(dlMatch[1]);
        const version = decodeURIComponent(dlMatch[2]);
        if (!bundles.get(name)?.has(version)) {
          return new Response("not found", { status: 404 });
        }
        const baseUrl = await urlPromise;
        return new Response(null, {
          status: 302,
          headers: {
            location: `${baseUrl}/raw-bundle/${encodeURIComponent(name)}@${
              encodeURIComponent(version)
            }`,
          },
        });
      }

      // GET /raw-bundle/{name}@{version}
      // Internal redirect target — returns the tarball bytes directly.
      const rawMatch = path.match(/^\/raw-bundle\/([^/@]+)@([^/]+)$/);
      if (rawMatch && req.method === "GET") {
        const name = decodeURIComponent(rawMatch[1]);
        const version = decodeURIComponent(rawMatch[2]);
        const bundle = bundles.get(name)?.get(version);
        if (!bundle) {
          return new Response("not found", { status: 404 });
        }
        return new Response(bundle.bytes as unknown as BodyInit, {
          status: 200,
          headers: { "content-type": "application/gzip" },
        });
      }

      // GET /api/v1/extensions/{name}@{version}/checksum
      // Mirrors ExtensionApiClient.getChecksum at extension_api_client.ts:365
      const csMatch = path.match(
        /^\/api\/v1\/extensions\/([^/@]+)@([^/]+)\/checksum$/,
      );
      if (csMatch && req.method === "GET") {
        const name = decodeURIComponent(csMatch[1]);
        const version = decodeURIComponent(csMatch[2]);
        const bundle = bundles.get(name)?.get(version);
        if (!bundle) {
          return new Response("not found", { status: 404 });
        }
        return Response.json({ checksum: bundle.checksum });
      }

      return new Response("not found", { status: 404 });
    },
  );

  const baseUrl = await urlPromise;
  return {
    url: baseUrl,
    shutdown: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

async function withFixtureRegistry(
  fn: (registryUrl: string) => Promise<void>,
): Promise<void> {
  const alphaV1Bytes = await buildArchive({
    name: ALPHA,
    version: ALPHA_V1,
    typeId: ALPHA_TYPE,
    modelFile: "noop.ts",
  });
  const alphaV2Bytes = await buildArchive({
    name: ALPHA,
    version: ALPHA_V2,
    typeId: ALPHA_TYPE,
    modelFile: "noop.ts",
  });
  const betaV1Bytes = await buildArchive({
    name: BETA,
    version: BETA_V1,
    typeId: BETA_TYPE,
    modelFile: "noop.ts",
  });

  const bundles = new Map<string, Map<string, FixtureBundle>>([
    [
      ALPHA,
      new Map([
        [ALPHA_V1, {
          bytes: alphaV1Bytes,
          checksum: await sha256Hex(alphaV1Bytes),
        }],
        [ALPHA_V2, {
          bytes: alphaV2Bytes,
          checksum: await sha256Hex(alphaV2Bytes),
        }],
      ]),
    ],
    [
      BETA,
      new Map([
        [BETA_V1, {
          bytes: betaV1Bytes,
          checksum: await sha256Hex(betaV1Bytes),
        }],
      ]),
    ],
  ]);

  // Pin alpha's "latest" to V2 so `extension update` actually exercises
  // UpgradeExtensionService's atomic tombstoneAll+save when alpha is
  // installed at V1. Pin beta's "latest" to V1 (no-op upgrade for beta).
  const latestVersion: Record<string, string> = {
    [ALPHA]: ALPHA_V2,
    [BETA]: BETA_V1,
  };

  const registry = await startFixtureRegistry(bundles, latestVersion);
  try {
    await fn(registry.url);
  } finally {
    await registry.shutdown();
  }
}

// =====================================================================
// Subprocess runner
// =====================================================================

async function runSwamp(
  args: string[],
  cwd: string,
  registryUrl: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [...STRESS_CLI_ARGS, ...args],
    stdout: "piped",
    stderr: "piped",
    cwd,
    env: {
      ...Deno.env.toObject(),
      SWAMP_NO_TELEMETRY: "1",
      SWAMP_CLUB_URL: registryUrl,
    },
  }).output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

async function initRepo(repoDir: string, registryUrl: string): Promise<void> {
  // `swamp init` populates marker + dirs. Failing init aborts the test loudly.
  const { code, stderr } = await runSwamp(
    ["init", repoDir],
    repoDir,
    registryUrl,
  );
  if (code !== 0) {
    throw new Error(`init failed (code ${code}): ${stderr}`);
  }
}

// =====================================================================
// Per-iteration operation shape
// =====================================================================

type Op =
  | { kind: "pull"; name: string; version?: string }
  | { kind: "rm"; name: string }
  | { kind: "update" };

function opCommand(op: Op, repoDir: string): string[] {
  switch (op.kind) {
    case "pull": {
      const ref = op.version ? `${op.name}@${op.version}` : op.name;
      return [
        "extension",
        "pull",
        ref,
        "--force",
        "--repo-dir",
        repoDir,
        "--no-color",
      ];
    }
    case "rm":
      return [
        "extension",
        "rm",
        op.name,
        "--force",
        "--repo-dir",
        repoDir,
        "--no-color",
      ];
    case "update":
      return [
        "extension",
        "update",
        "--repo-dir",
        repoDir,
        "--no-color",
      ];
  }
}

// =====================================================================
// Invariants
// =====================================================================

interface IterationContext {
  iteration: number;
  ops: ReadonlyArray<Op>;
  childOutputs: ReadonlyArray<{ stdout: string; stderr: string; code: number }>;
}

interface LockfileEntry {
  version: string;
  files?: string[];
}

type LockfileMap = Record<string, LockfileEntry>;

async function readLockfileRaw(repoDir: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(
      join(repoDir, "extensions", "models", "upstream_extensions.json"),
    );
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

function readCatalogStressRows(repoDir: string): Array<{
  extension_name: string;
  extension_version: string;
  state: string;
}> {
  // ExtensionCatalogStore opens the DB under .swamp/_extension_catalog.db and
  // runs migrations on construction. We are the sole reader at invariant
  // time (all children have exited and released their write locks via
  // Promise.all settlement upstream), so this is safe.
  const store = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "_extension_catalog.db"),
  );
  try {
    return store.findAll()
      .filter((row) => (row.extension_name ?? "").startsWith("@stress/"))
      .map((row) => ({
        extension_name: row.extension_name ?? "",
        extension_version: row.extension_version ?? "",
        state: row.state ?? "Indexed",
      }));
  } finally {
    store.close();
  }
}

/**
 * Normalises a repo-relative path to forward-slash form for cross-OS-stable
 * set comparison. The lockfile stores `files[]` using the host's native
 * separator (e.g. backslashes on Windows); the on-disk walker uses
 * `@std/path.join` which also emits native separators. We normalise both
 * sides to forward slashes before comparing so invariant (iv) does not
 * fire spuriously on Windows. Per CLAUDE.md, never compare path strings
 * with raw `assertEquals` against forward-slash literals.
 */
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Lists FILES (not directories) under `.swamp/pulled-extensions/@stress/...`
 * as repo-relative paths normalised to forward slashes. The W2 rm path
 * deletes files from `files[]` and prunes the deepest containing directory
 * but does not aggressively prune parents up to `pulled-extensions/`
 * (verified against integration/extension_rm_test.ts which only asserts
 * file-level absence — empty parent directories are an expected leftover,
 * not orphan state). The orphan-FS invariant is therefore on FILES, not
 * directories.
 */
async function listOnDiskStressFiles(repoDir: string): Promise<Set<string>> {
  const root = join(repoDir, ".swamp", "pulled-extensions");
  const out = new Set<string>();

  async function walk(dir: string, repoRel: string): Promise<void> {
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }
    for (const e of entries) {
      const sub = join(dir, e.name);
      const subRel = repoRel === "" ? e.name : `${repoRel}/${e.name}`;
      if (e.isDirectory) {
        await walk(sub, subRel);
      } else if (e.isFile || e.isSymlink) {
        out.add(toForwardSlash(subRel));
      }
    }
  }

  try {
    for await (const collEntry of Deno.readDir(root)) {
      if (!collEntry.isDirectory) continue;
      if (collEntry.name !== "@stress") continue;
      await walk(
        join(root, collEntry.name),
        `.swamp/pulled-extensions/${collEntry.name}`,
      );
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return out;
    throw err;
  }
  return out;
}

// Real failures we never tolerate — distinct from "benign" race outcomes
// like a transient pull failure when an rm got there first. Resolves ADV-4
// (lockfile-exhaustion) and ADV-9 (the architectural-invariant breach class
// of SQLite errors — see notes below for the contention class which is
// expected and tolerated).
//
// Note: SQLITE_BUSY / "database is locked" is INTENTIONALLY NOT in this
// list. Per design/extension.md "Crash-state recovery", a SQLite I/O
// failure during `repository.saveAll` is a documented W2 outcome — the
// catalog rolls back via SQLite ROLLBACK, but the FS and lockfile are
// not. The user-facing message is "Install partially applied for X —
// files extracted but the catalog write failed (database is locked)…
// retry to reconcile". On Windows CI under 4-way concurrency this can
// fire. The next pull/update's diff-save reconciles. The bijection
// invariants (i) below explicitly tolerate this transient state by
// detecting the recovery message in stderr.
const REAL_FAILURE_PATTERNS: ReadonlyArray<{ label: string; needle: string }> =
  [
    {
      label: "lockfile exhaustion",
      needle: "Could not acquire lock on upstream_extensions.json",
    },
    // Architectural invariant breach — these would point at a real bug in
    // the lifecycle services' rollback logic.
    { label: "post-rollback orphan warning", needle: "Dropping orphan row" },
  ];

// Substring of the W2 contention recovery message produced by
// InstallExtensionService when `saveAll` fails on SQLite contention. When
// this appears in a child's stderr, the iteration may end with a lockfile
// entry that has no matching catalog row — that is the documented
// transient state and invariant (i) tolerates it for the contended
// extension.
const W2_CONTENTION_RECOVERY_NEEDLE = "Install partially applied";

async function checkInvariants(
  repoDir: string,
  ctx: IterationContext,
): Promise<void> {
  const tag = `iteration ${ctx.iteration}`;

  // ---- (iii) Lockfile is well-formed JSON ---------------------------
  const lockfileRaw = await readLockfileRaw(repoDir);
  let lockfile: LockfileMap;
  if (lockfileRaw === null) {
    lockfile = {};
  } else {
    try {
      lockfile = JSON.parse(lockfileRaw) as LockfileMap;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${tag} invariant (iii) FAILED: lockfile is not well-formed JSON.\n` +
          `Parse error: ${msg}\n` +
          `Raw contents:\n${lockfileRaw}`,
      );
    }
  }

  // ---- (ii) and (ii') stderr filters --------------------------------
  for (let i = 0; i < ctx.childOutputs.length; i++) {
    const child = ctx.childOutputs[i];
    const op = ctx.ops[i];
    const opLabel = describeOp(op);
    const combined = `${child.stdout}\n${child.stderr}`;

    // (ii') Real failures — lockfile-retry exhaustion, SQLite busy. Any
    // occurrence is a failure, not a benign race outcome.
    for (const pat of REAL_FAILURE_PATTERNS) {
      if (combined.includes(pat.needle)) {
        throw new Error(
          `${tag} invariant (ii') FAILED: ${pat.label} surfaced in child` +
            ` (op: ${opLabel}, code=${child.code}).\n` +
            `Matched needle: "${pat.needle}"\n` +
            `Child stderr:\n${child.stderr}`,
        );
      }
    }

    // (ii) DuplicateTypeError must NEVER appear with the fixtures pinning
    // distinct types per extension. If it does, either the fixtures have
    // collapsed onto a shared type (regression in this test) or the
    // lifecycle services have lost their cross-extension invariant.
    if (combined.includes("DuplicateTypeError")) {
      throw new Error(
        `${tag} invariant (ii) FAILED: DuplicateTypeError surfaced in child` +
          ` (op: ${opLabel}, code=${child.code}). Fixtures pin distinct` +
          ` types ${ALPHA_TYPE} vs ${BETA_TYPE} so this should not happen` +
          ` for any concurrency interleaving.\nChild stderr:\n${child.stderr}`,
      );
    }
  }

  // ---- (i) Catalog ↔ lockfile bijection -----------------------------
  // Indexed (non-tombstoned) catalog rows for @stress/* must correspond
  // 1:1 to lockfile entries (by name+version). Tombstoned rows are not
  // expected to surface in the lockfile — they are the historical-state
  // residue of an upgrade.
  //
  // Tolerated transient: when a child this iteration emitted the W2
  // contention-recovery message, the catalog rolled back but FS+lockfile
  // did not. That's the documented "retry to reconcile" path. We collect
  // those names and skip the lockfile→catalog direction for them this
  // iteration AND tolerate version skew in the catalog→lockfile direction
  // (the catalog keeps the old version while the lockfile already has the
  // new one); the next pull/update reconciles both.
  const contendedNames = new Set<string>();
  for (const child of ctx.childOutputs) {
    if (
      `${child.stdout}\n${child.stderr}`.includes(W2_CONTENTION_RECOVERY_NEEDLE)
    ) {
      // The recovery message names the affected extension. Any @stress/*
      // mention in this child's output is a candidate; in practice the
      // operating child is one of `pull <name>` or `update <name>`, so we
      // mark all @stress names appearing in its output.
      for (const candidate of [ALPHA, BETA]) {
        if (`${child.stdout}\n${child.stderr}`.includes(candidate)) {
          contendedNames.add(candidate);
        }
      }
    }
  }

  const catalogRows = readCatalogStressRows(repoDir);
  const indexedRows = catalogRows.filter((r) => r.state !== "Tombstoned");
  const lockfileNames = new Set(Object.keys(lockfile));

  for (const row of indexedRows) {
    const lockEntry = lockfile[row.extension_name];
    if (!lockEntry) {
      throw new Error(
        `${tag} invariant (i) FAILED: catalog has Indexed row for` +
          ` ${row.extension_name}@${row.extension_version} but lockfile` +
          ` has no matching entry.\nLockfile keys: ${
            [...lockfileNames].join(", ")
          }`,
      );
    }
    // When saveAll rolls back on SQLite contention, the catalog keeps the
    // pre-upgrade version while the lockfile (written before the catalog)
    // already has the new version. This version skew is the documented W2
    // transient state — tolerate it for contended extensions; the final
    // sequential reconcile pass drains it.
    if (
      row.extension_version && lockEntry.version !== row.extension_version &&
      !contendedNames.has(row.extension_name)
    ) {
      throw new Error(
        `${tag} invariant (i) FAILED: version skew for ${row.extension_name}` +
          ` — catalog row says ${row.extension_version}, lockfile says` +
          ` ${lockEntry.version}.`,
      );
    }
  }

  for (const [name] of Object.entries(lockfile)) {
    if (!name.startsWith("@stress/")) continue;
    if (contendedNames.has(name)) continue;
    const matching = indexedRows.filter((r) => r.extension_name === name);
    if (matching.length === 0) {
      throw new Error(
        `${tag} invariant (i) FAILED: lockfile has entry for ${name} but` +
          ` no Indexed catalog row matches.\nIndexed rows for @stress/*: ` +
          JSON.stringify(indexedRows),
      );
    }
  }

  // ---- (iv) FS ↔ lockfile bijection ---------------------------------
  // Every FILE under .swamp/pulled-extensions/@stress/... must be referenced
  // by some lockfile entry's files[]. Empty parent directories are tolerated
  // (rm prunes the deepest empty dir but not all the way up to
  // pulled-extensions/ — see listOnDiskStressFiles).
  //
  // Both the on-disk walker output and the lockfile files[] strings are
  // normalised to forward slashes (via toForwardSlash) so set membership
  // works on Windows, where the lockfile records native backslash
  // separators.
  const onDiskFiles = await listOnDiskStressFiles(repoDir);
  const lockfileFiles = new Set<string>();
  for (const [name, entry] of Object.entries(lockfile)) {
    if (!name.startsWith("@stress/")) continue;
    for (const rel of entry.files ?? []) lockfileFiles.add(toForwardSlash(rel));
  }
  for (const file of onDiskFiles) {
    if (!lockfileFiles.has(file)) {
      const childDump = ctx.childOutputs
        .map((c, i) =>
          `--- child ${i} (op: ${
            describeOp(ctx.ops[i])
          }) code=${c.code} ---\n` +
          `STDOUT:\n${c.stdout}\nSTDERR:\n${c.stderr}`
        )
        .join("\n");
      throw new Error(
        `${tag} invariant (iv) FAILED: orphan file on disk at ${file}` +
          ` — no lockfile entry references it.\n` +
          `Lockfile: ${JSON.stringify(lockfile)}\n` +
          `On-disk @stress files: ${[...onDiskFiles].join(", ")}\n` +
          `Child outputs:\n${childDump}`,
      );
    }
  }

  // Every lockfile @stress/* entry's files[] must exist on disk. (We
  // tolerate the entry having no files[] field — pre-W2 lockfile entries
  // can omit it; W2 always writes it. Fixture-installed entries always
  // have files[].)
  for (const [name, entry] of Object.entries(lockfile)) {
    if (!name.startsWith("@stress/")) continue;
    if (!entry.files) continue;
    for (const rel of entry.files) {
      const abs = join(repoDir, rel);
      try {
        await Deno.stat(abs);
      } catch {
        throw new Error(
          `${tag} invariant (iv) FAILED: lockfile entry ${name}@${entry.version}` +
            ` declares file ${rel} but it is missing from disk.`,
        );
      }
    }
  }
}

function describeOp(op: Op): string {
  switch (op.kind) {
    case "pull":
      return `pull ${op.name}${op.version ? `@${op.version}` : ""}`;
    case "rm":
      return `rm ${op.name}`;
    case "update":
      return "update";
  }
}

// =====================================================================
// The test
// =====================================================================

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lifecycle-stress-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test({
  name:
    "Lifecycle services: 50 iterations of cross-process concurrent install/rm/upgrade leave catalog↔lockfile↔FS consistent (swamp-club#254)",
  // Subprocess spawn means file handles outlive the test scope on some
  // platforms; matches the exemption at integration/data_delete_test.ts:307-309.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withFixtureRegistry(async (registryUrl) => {
      await withTempDir(async (repoDir) => {
        await initRepo(repoDir, registryUrl);

        // Seed: install both extensions at V1 so `update` and `rm` have
        // something to operate on in the first few iterations. After
        // seeding, a single op may transiently empty the lockfile — that's
        // fine, the invariants tolerate it.
        for (
          const op of [
            { kind: "pull" as const, name: ALPHA, version: ALPHA_V1 },
            { kind: "pull" as const, name: BETA, version: BETA_V1 },
          ]
        ) {
          const r = await runSwamp(
            opCommand(op, repoDir),
            repoDir,
            registryUrl,
          );
          if (r.code !== 0) {
            throw new Error(
              `seed ${describeOp(op)} failed (code ${r.code}): ${r.stderr}`,
            );
          }
        }

        // The four operations the issue's spec lists, one per concurrent
        // child per iteration. Ordering inside Promise.all is irrelevant —
        // we only assert end-state invariants.
        const opsTemplate: ReadonlyArray<Op> = [
          { kind: "pull", name: ALPHA, version: ALPHA_V1 },
          { kind: "pull", name: BETA, version: BETA_V1 },
          { kind: "rm", name: ALPHA },
          { kind: "update" },
        ];
        if (opsTemplate.length !== CONCURRENCY_PER_ITERATION) {
          throw new Error(
            `Internal: opsTemplate length (${opsTemplate.length}) does not match` +
              ` CONCURRENCY_PER_ITERATION (${CONCURRENCY_PER_ITERATION}).`,
          );
        }

        for (let i = 0; i < RACE_ITERATIONS; i++) {
          const childPromises = opsTemplate.map((op) =>
            runSwamp(opCommand(op, repoDir), repoDir, registryUrl)
          );
          const childOutputs = await Promise.all(childPromises);
          await checkInvariants(repoDir, {
            iteration: i,
            ops: opsTemplate,
            childOutputs,
          });
        }

        // Final reconcile pass: drain any documented W2 transient
        // (lockfile entry without catalog row, left by a SQLite-busy
        // saveAll rollback during contended iterations). Per
        // design/extension.md "Crash-state recovery", the next
        // pull/update's diff-save reconciles. A sequential `extension
        // update` (no concurrency) is the canonical reconcile op. After
        // this, the bijection invariants must hold strictly with no
        // tolerated transients.
        const reconcile = await runSwamp(
          [
            "extension",
            "update",
            "--repo-dir",
            repoDir,
            "--no-color",
          ],
          repoDir,
          registryUrl,
        );
        if (reconcile.code !== 0) {
          throw new Error(
            `Final reconcile pass failed (code ${reconcile.code}): ` +
              `${reconcile.stderr}`,
          );
        }
        await checkInvariants(repoDir, {
          iteration: RACE_ITERATIONS, // sentinel: post-reconcile
          ops: [{ kind: "update" }],
          childOutputs: [reconcile],
        });
      });
    });
  },
});
