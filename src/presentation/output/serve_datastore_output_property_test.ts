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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  escapeControlCharacters,
  escapeControlCharactersInText,
} from "../../domain/control_characters.ts";
import type { LockInfo } from "../../domain/datastore/distributed_lock.ts";
import { FileLock } from "../../infrastructure/persistence/file_lock.ts";
import { reclaimModelLocks } from "../../cli/repo_context.ts";
import {
  createDatastoreLockReleaseRenderer,
  createDatastoreLockStatusRenderer,
} from "../renderers/datastore_lock.ts";
import { createNamespaceListRenderer } from "../renderers/datastore_namespace_list.ts";
import {
  createDatastoreQuarantineAcceptRenderer,
  createDatastoreQuarantineDiscardRenderer,
} from "../renderers/datastore_quarantine.ts";
import { createDatastoreSetupRenderer } from "../renderers/datastore_setup.ts";
import { createDatastoreStatusRenderer } from "../renderers/datastore_status.ts";
import { createDoctorSecretsRenderer } from "../renderers/doctor_secrets.ts";
import { createDoctorVaultsRenderer } from "../renderers/doctor_vaults.ts";
import {
  createDoctorDatastoresRenderer,
  createRepairDatastoresRenderer,
  createUnreadableVersionsRepairRenderer,
  DatastoreRepairJsonReport,
} from "../renderers/doctor_datastores.ts";
import {
  assertNoControlCharacters,
  captureRaw,
} from "./terminal_output_test_helpers.ts";

await initializeLogging({});

const text = fc.string({
  unit: fc.oneof(
    fc.constantFrom("\x00", "\x07", "\x1b", "\x7f", "\x9b", "\n", "\r", "["),
    fc.constantFrom("\x1b[31m", "\x1b[2J", "\x1b]0;t\x07"),
    fc.fullUnicode(),
  ),
});

// a shared datastore or another serve may skip the validation these types assume
function texts<K extends string>(
  ...keys: K[]
): fc.Arbitrary<Record<K, string>> {
  return fc.array(text, { minLength: keys.length, maxLength: keys.length })
    .map((values) =>
      Object.fromEntries(keys.map((k, i) => [k, values[i]])) as Record<
        K,
        string
      >
    );
}

function assertEscaped(
  output: string,
  single: readonly string[],
  multiLine: readonly string[] = [],
): void {
  assertNoControlCharacters(output);
  for (const value of single) {
    const escaped = escapeControlCharacters(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
  for (const value of multiLine) {
    const escaped = escapeControlCharactersInText(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
}

const RUNS = { numRuns: 50 };

Deno.test("datastore lock status and release: no holder-supplied control character reaches the terminal, every value is still there escaped, and JSON keeps it raw", () => {
  fc.assert(
    fc.property(
      texts(
        "holder",
        "hostname",
        "acquiredAt",
        "lockScope",
        "lockKey",
        "expiresAt",
        "principal",
        "reason",
        "leaseHolder",
        "previous",
      ),
      (t) => {
        const data = {
          held: true,
          info: {
            holder: t.holder,
            hostname: t.hostname,
            pid: 7,
            acquiredAt: t.acquiredAt,
            ttlMs: 1000,
          },
          datastoreType: "filesystem",
          lockScope: t.lockScope,
        };
        const status = createDatastoreLockStatusRenderer("log").handlers();
        assertEscaped(
          captureRaw(() => status.model_lock({ kind: "model_lock", data })),
          [t.holder, t.hostname, t.acquiredAt, t.lockScope],
        );
        assertEscaped(
          captureRaw(() =>
            status.serve_lease({
              kind: "serve_lease",
              data: {
                lockKey: t.lockKey,
                heldBy: "other",
                expiresAt: t.expiresAt,
                holder: {
                  principal: t.principal,
                  explicit: true,
                  expiresAt: t.expiresAt,
                },
              },
            })
          ),
          [t.lockKey, t.expiresAt, t.principal],
        );
        const release = createDatastoreLockReleaseRenderer("log").handlers();
        assertEscaped(
          captureRaw(() =>
            release.completed({
              kind: "completed",
              data: { released: false, reason: t.reason },
            })
          ),
          [t.reason],
        );
        assertEscaped(
          captureRaw(() =>
            release.completed({
              kind: "completed",
              data: {
                released: true,
                leaseHolder: t.leaseHolder,
                previousHolder: { ...data.info, holder: t.previous },
              },
            })
          ),
          [t.leaseHolder, t.previous],
        );
        const json = captureRaw(() =>
          createDatastoreLockStatusRenderer("json").handlers().model_lock({
            kind: "model_lock",
            data,
          })
        );
        assertEquals(JSON.parse(json), data);
      },
    ),
    RUNS,
  );
});

Deno.test("datastore namespace list: namespaces another checkout registered are escaped in the table", () => {
  fc.assert(
    fc.property(texts("namespace", "repoId", "registeredAt"), (t) => {
      const output = captureRaw(() =>
        createNamespaceListRenderer("log").handlers().completed({
          kind: "completed",
          data: {
            namespaces: [{
              namespace: t.namespace,
              repoId: t.repoId,
              registeredAt: t.registeredAt,
              isCurrent: false,
            }],
          } as never,
        })
      );
      assertEscaped(output, [
        t.namespace,
        t.repoId,
        t.registeredAt.slice(0, 10),
      ]);
    }),
    RUNS,
  );
});

Deno.test("datastore quarantine accept and discard: quarantine authors and admins are escaped, and JSON keeps them raw", () => {
  fc.assert(
    fc.property(
      texts("txnId", "partition", "author", "by", "at", "version"),
      (t) => {
        const accepted = {
          txnId: t.txnId,
          duplicate: false,
          partition: t.partition,
          author: t.author,
          acceptedBy: t.by,
          acceptedAt: t.at,
          renumbered: [{ name: t.version, from: 1, to: 2 }],
        };
        assertEscaped(
          captureRaw(() =>
            createDatastoreQuarantineAcceptRenderer("log").handlers()
              .completed({ kind: "completed", data: accepted as never })
          ),
          [t.txnId, t.partition, t.author, t.by, t.at, t.version],
        );
        assertEscaped(
          captureRaw(() =>
            createDatastoreQuarantineDiscardRenderer("log").handlers()
              .completed({
                kind: "completed",
                data: {
                  txnId: t.txnId,
                  duplicate: false,
                  partition: t.partition,
                  author: t.author,
                  discardedBy: t.by,
                  discardedAt: t.at,
                } as never,
              })
          ),
          [t.txnId, t.partition, t.author, t.by, t.at],
        );
        const json = captureRaw(() =>
          createDatastoreQuarantineAcceptRenderer("json").handlers()
            .completed({ kind: "completed", data: accepted as never })
        );
        assertEquals(JSON.parse(json), accepted);
      },
    ),
    RUNS,
  );
});

Deno.test("datastore setup: datastore-supplied paths, names and errors are escaped", () => {
  fc.assert(
    fc.property(
      texts(
        "message",
        "type",
        "path",
        "namespace",
        "dir",
        "source",
        "destination",
        "error",
        "retryHint",
      ),
      (t) => {
        const handlers = createDatastoreSetupRenderer("log").handlers();
        assertEscaped(
          captureRaw(() =>
            handlers.warning({
              kind: "warning",
              data: { code: "empty_config_tier", message: t.message },
            } as never)
          ),
          [],
          [t.message],
        );
        assertEscaped(
          captureRaw(() =>
            handlers.completed({
              kind: "completed",
              data: {
                type: t.type,
                path: t.path,
                namespace: t.namespace,
                filesCopied: 1,
                filesPulled: 1,
                bytesCopied: 1,
                directoriesMigrated: [t.dir],
                errors: [t.error],
                retryHint: t.retryHint,
                sourcePath: `s${t.source}`,
                destinationPath: `d${t.destination}`,
              },
            })
          ),
          [
            t.type,
            t.path,
            t.namespace,
            t.dir,
            `s${t.source}`,
            `d${t.destination}`,
          ],
          [t.error, t.retryHint],
        );
      },
    ),
    RUNS,
  );
});

Deno.test("datastore status: leases, outbox entries and quarantined changes are escaped, and JSON keeps them raw", () => {
  fc.assert(
    fc.property(
      texts(
        "type",
        "path",
        "message",
        "dir",
        "lockKey",
        "holder",
        "expiresAt",
        "partition",
        "txnId",
        "savedAt",
        "behavior",
        "name",
        "reason",
        "next",
        "author",
        "by",
        "absent",
      ),
      (t) => {
        const data = {
          type: t.type,
          path: t.path,
          healthy: false,
          message: t.message,
          latencyMs: 3,
          directories: [t.dir],
          exclude: [t.dir],
          explicitLeases: [{
            lockKey: t.lockKey,
            holder: t.holder,
            expiresAt: t.expiresAt,
          }],
          heldLeases: [{
            lockKey: t.lockKey,
            fence: 1,
            expiresAt: t.expiresAt,
          }],
          outbox: [{
            state: "rejected" as const,
            partition: t.partition,
            txnId: t.txnId,
            reason: t.reason,
            savedAt: t.savedAt,
            writes: [{ behavior: t.behavior, name: t.name, version: 1 }],
            next: t.next,
          }],
          quarantine: [
            {
              txnId: t.txnId,
              partition: t.partition,
              author: t.author,
              reason: t.reason,
              depositedAt: t.savedAt,
              state: "held" as const,
            },
            {
              txnId: t.txnId,
              partition: t.partition,
              author: t.author,
              reason: t.reason,
              depositedAt: t.savedAt,
              state: "discarded" as const,
              discardedBy: t.by,
            },
            {
              txnId: t.txnId,
              partition: t.partition,
              author: t.author,
              reason: t.reason,
              depositedAt: t.savedAt,
              state: "accepted" as const,
              acceptedBy: t.by,
            },
          ],
          serveSectionAbsent: t.absent,
        };
        assertEscaped(
          captureRaw(() =>
            createDatastoreStatusRenderer("log").handlers().completed({
              kind: "completed",
              data,
            })
          ),
          [
            t.type,
            t.path,
            t.dir,
            t.lockKey,
            t.holder,
            t.expiresAt,
            t.partition,
            t.txnId,
            t.savedAt,
            t.behavior,
            t.name,
            t.reason,
            t.next,
            t.author,
            t.by,
            t.absent,
          ],
          [t.message],
        );
        const json = captureRaw(() =>
          createDatastoreStatusRenderer("json").handlers().completed({
            kind: "completed",
            data,
          })
        );
        assertEquals(JSON.parse(json), data);
      },
    ),
    RUNS,
  );
});

Deno.test("doctor secrets and doctor vaults: definition names, paths and vault names are escaped, and JSON keeps them raw", () => {
  fc.assert(
    fc.property(
      texts("name", "type", "path", "vaultName", "vaultKey", "expression"),
      (t) => {
        const secrets = {
          scanned: 1,
          findings: [{
            definitionName: t.name,
            type: t.type,
            remediations: [{
              path: t.path,
              vaultName: t.vaultName,
              vaultKey: t.vaultKey,
              expression: t.expression,
            }],
          }],
          unresolved: [{ definitionName: t.name, type: t.type }],
        };
        assertEscaped(
          captureRaw(() =>
            createDoctorSecretsRenderer("log").handlers().completed({
              kind: "completed",
              data: secrets as never,
            })
          ),
          [t.name, t.type, t.path, t.vaultName, t.vaultKey, t.expression],
        );
        const json = JSON.parse(
          captureRaw(() =>
            createDoctorSecretsRenderer("json").handlers().completed({
              kind: "completed",
              data: secrets as never,
            })
          ),
        );
        assertEquals(json.findings, secrets.findings);
        assertEscaped(
          captureRaw(() =>
            createDoctorVaultsRenderer("log").handlers().completed({
              kind: "completed",
              data: {
                scanned: 1,
                hasVault: true,
                findings: [{ definitionName: t.name, type: t.type }],
                unresolved: [{ definitionName: t.name, type: t.type }],
                fallbackWarning: {
                  fallbackVault: t.vaultName,
                  unregisteredDefaultVault: t.vaultKey,
                  userVaults: [t.path],
                  definitions: [{ definitionName: t.expression, type: t.type }],
                },
              } as never,
            })
          ),
          [t.name, t.type, t.vaultName, t.vaultKey, t.path, t.expression],
        );
      },
    ),
    RUNS,
  );
});

Deno.test("doctor datastores: findings read from a shared datastore are escaped, in the scan and in the repairs", () => {
  fc.assert(
    fc.property(
      texts(
        "message",
        "namespace",
        "type",
        "modelName",
        "dataName",
        "itemId",
        "at",
        "recordKey",
        "reason",
        "advice",
        "chunk",
        "vaultName",
        "vaultType",
        "description",
      ),
      (t) => {
        const output = captureRaw(() =>
          createDoctorDatastoresRenderer("log").handlers().completed({
            kind: "completed",
            data: {
              datastoreType: "s3",
              isCustom: true,
              healthFindings: [{
                check: "health",
                passed: false,
                message: t.message,
              }],
              contaminationFinding: {
                foreignNamespaces: [{ namespace: t.namespace, objectCount: 1 }],
                totalForeignObjects: 1,
              },
              catalogCompletenessFinding: {
                shortfalls: [{
                  typeNormalized: t.type,
                  catalogRecords: 1,
                  diskRecords: 2,
                }],
                surplus: [],
              },
              unreadableVersionsFinding: {
                unreadableVersions: 1,
                records: 1,
                darkRecords: 0,
                findings: [{
                  modelType: "t",
                  modelId: "m",
                  modelName: t.modelName,
                  dataName: t.dataName,
                  version: 1,
                  reason: "metadata_empty",
                  latest: false,
                  readableVersion: null,
                }],
              },
              retentionFinding: {
                configured: true,
                automatic: true,
                checkedAt: "x",
                kinds: [{
                  kind: "workflowRuns",
                  retention: "30d",
                  cutoff: "c",
                  scanned: true,
                  overdue: 1,
                  items: [{ id: t.itemId, at: t.at }],
                  kept: 0,
                  watermark: { lastPassAt: t.at, cutoff: t.at, complete: true },
                }],
              },
              v3ContentFinding: {
                unreadableRecords: 1,
                unreadable: [{
                  namespace: t.namespace,
                  recordKey: t.recordKey,
                  reason: t.reason,
                  chunk: t.chunk,
                  advice: t.advice,
                }],
                atRiskCopies: 1,
                atRisk: [{
                  namespace: t.namespace,
                  sha256: "b",
                  recordKey: t.recordKey,
                  size: 1,
                }],
                atRiskDir: "d",
                atRiskAdvice: "a",
                tornChunks: 1,
                torn: [{
                  namespace: t.namespace,
                  sha256: "c",
                  recordKey: t.recordKey,
                  expectedSize: 2,
                  size: 1,
                  advice: t.advice,
                }],
              },
              vaultMismatchFindings: [{
                vaultName: t.vaultName,
                vaultType: t.vaultType,
              }],
            } as never,
          })
        );
        assertEscaped(
          output,
          [
            t.namespace,
            t.type,
            t.modelName,
            t.dataName,
            t.itemId,
            t.at,
            t.recordKey,
            t.reason,
            t.advice,
            t.chunk,
            t.vaultName,
            t.vaultType,
          ],
          [t.message],
        );

        const repair = createRepairDatastoresRenderer(
          "log",
          new DatastoreRepairJsonReport(),
        ).handlers();
        assertEscaped(
          captureRaw(() => {
            repair.preview({
              kind: "preview",
              namespace: "own",
              contamination: {
                foreignNamespaces: [{ namespace: t.namespace, objectCount: 1 }],
                totalForeignObjects: 1,
              },
            } as never);
            repair.step({
              kind: "step",
              step: 1,
              total: 1,
              description: t.description,
            } as never);
          }),
          [t.namespace, t.description],
        );
        assertEscaped(
          captureRaw(() =>
            createUnreadableVersionsRepairRenderer(
              "log",
              new DatastoreRepairJsonReport(),
            ).handlers().preview({
              kind: "preview",
              records: [{
                modelType: "t",
                modelId: "m",
                modelName: t.modelName,
                dataName: t.dataName,
                removeVersions: [1],
                markerUnreadable: false,
                becomesLatest: null,
              }],
            })
          ),
          [t.modelName, t.dataName],
        );
      },
    ),
    RUNS,
  );
});

const globalLockReturning = (infos: Array<LockInfo | null>) => {
  let inspects = 0;
  return {
    inspect: () =>
      Promise.resolve(infos[Math.min(inspects++, infos.length - 1)]),
  };
};

Deno.test("reclaimModelLocks: the holder a structural command wrote to the shared global lock is escaped in the progress line", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lock-escape-" });
  try {
    await fc.assert(
      fc.asyncProperty(text, async (holder) => {
        const lock = new FileLock(dir, { lockKey: "a.lock", ttlMs: 60_000 });
        await lock.acquire();
        try {
          const working: LockInfo = {
            holder,
            hostname: "elsewhere",
            pid: 4242,
            acquiredAt: new Date().toISOString(),
            ttlMs: 30_000,
            nonce: "global-nonce",
            skipping: [lock.heldNonce!],
          };
          const lines: string[] = [];
          await reclaimModelLocks(
            [lock],
            globalLockReturning([working, null]),
            { pollMs: 1, progressWriter: (line) => lines.push(line) },
          );
          assertEscaped(lines.join("\n"), [holder]);
        } finally {
          await lock.release();
        }
      }),
      { numRuns: 20 },
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
