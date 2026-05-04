# Examples — Extension Datastores

## Minimal Local Datastore

A simple local filesystem variant that stores data in a custom directory:

```typescript
// extensions/datastores/custom-fs/mod.ts
import { z } from "npm:zod@4";
import { join } from "@std/path";

const ConfigSchema = z.object({
  basePath: z.string().describe("Base directory for data storage"),
});

export const datastore = {
  type: "@myorg/custom-fs",
  name: "Custom Filesystem",
  description:
    "Stores data in a custom local directory with file-based locking",
  configSchema: ConfigSchema,
  createProvider: (config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);

    return {
      createLock: (
        datastorePath: string,
        options?: {
          lockKey?: string;
          ttlMs?: number;
          retryIntervalMs?: number;
          maxWaitMs?: number;
        },
      ) => {
        const lockFile = `${datastorePath}/${options?.lockKey ?? ".lock"}`;
        const ttlMs = options?.ttlMs ?? 30_000;
        const retryIntervalMs = options?.retryIntervalMs ?? 1_000;
        const maxWaitMs = options?.maxWaitMs ?? 60_000;
        let heartbeatId: number | undefined;

        return {
          acquire: async () => {
            const start = Date.now();
            while (Date.now() - start < maxWaitMs) {
              try {
                const info = {
                  holder: `${
                    Deno.env.get("USER") ?? "unknown"
                  }@${Deno.hostname()}`,
                  hostname: Deno.hostname(),
                  pid: Deno.pid,
                  acquiredAt: new Date().toISOString(),
                  ttlMs,
                  nonce: crypto.randomUUID(),
                };
                await Deno.writeTextFile(lockFile, JSON.stringify(info), {
                  createNew: true,
                });
                // Start heartbeat
                heartbeatId = setInterval(async () => {
                  try {
                    const current = JSON.parse(
                      await Deno.readTextFile(lockFile),
                    );
                    current.acquiredAt = new Date().toISOString();
                    await Deno.writeTextFile(lockFile, JSON.stringify(current));
                  } catch { /* lock may have been released */ }
                }, ttlMs / 3);
                return;
              } catch {
                // Check if existing lock is stale
                try {
                  const existing = JSON.parse(
                    await Deno.readTextFile(lockFile),
                  );
                  const age = Date.now() -
                    new Date(existing.acquiredAt).getTime();
                  if (age > existing.ttlMs) {
                    await Deno.remove(lockFile);
                    continue;
                  }
                } catch { /* lock file gone, retry */ }
                await new Promise((r) => setTimeout(r, retryIntervalMs));
              }
            }
            throw new Error(`Lock timeout after ${maxWaitMs}ms`);
          },
          release: async () => {
            if (heartbeatId !== undefined) {
              clearInterval(heartbeatId);
              heartbeatId = undefined;
            }
            try {
              await Deno.remove(lockFile);
            } catch { /* already released */ }
          },
          withLock: async <T>(fn: () => Promise<T>): Promise<T> => {
            // Implementation calls acquire/release around fn
            throw new Error("Use acquire/release directly");
          },
          inspect: async () => {
            try {
              return JSON.parse(await Deno.readTextFile(lockFile));
            } catch {
              return null;
            }
          },
          forceRelease: async (expectedNonce: string) => {
            try {
              const info = JSON.parse(await Deno.readTextFile(lockFile));
              if (info.nonce === expectedNonce) {
                await Deno.remove(lockFile);
                return true;
              }
            } catch { /* no lock */ }
            return false;
          },
        };
      },

      createVerifier: () => ({
        verify: async () => {
          const start = performance.now();
          try {
            await Deno.stat(parsed.basePath);
            // Test write access
            const testFile = `${parsed.basePath}/.health-check`;
            await Deno.writeTextFile(testFile, "ok");
            await Deno.remove(testFile);
            return {
              healthy: true,
              message: "OK",
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@myorg/custom-fs",
              details: { path: parsed.basePath },
            };
          } catch (error) {
            return {
              healthy: false,
              message: String(error),
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@myorg/custom-fs",
            };
          }
        },
      }),

      resolveDatastorePath: (_repoDir: string) => parsed.basePath,
    };
  },
};
```

### `.swamp.yaml` config

```yaml
datastore:
  type: "@myorg/custom-fs"
  config:
    basePath: "/data/swamp-storage"
```

### Environment variable

```bash
export SWAMP_DATASTORE='@myorg/custom-fs:{"basePath":"/data/swamp-storage"}'
```

## Remote Datastore with Sync

A remote datastore that caches locally and syncs to a remote backend:

```typescript
// extensions/datastores/remote-store/mod.ts
import { z } from "npm:zod@4";

const ConfigSchema = z.object({
  endpoint: z.string().url(),
  bucket: z.string(),
  region: z.string().default("us-east-1"),
});

export const datastore = {
  type: "@myorg/remote-store",
  name: "Remote Object Store",
  description: "Stores data in a remote object store with local caching",
  configSchema: ConfigSchema,
  createProvider: (config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);

    return {
      createLock: (
        datastorePath: string,
        options?: {
          lockKey?: string;
          ttlMs?: number;
          retryIntervalMs?: number;
          maxWaitMs?: number;
        },
      ) => {
        // Remote lock implementation (e.g., conditional PUT)
        return {
          acquire: async () => {/* remote lock acquire */},
          release: async () => {/* remote lock release */},
          withLock: async <T>(fn: () => Promise<T>) => fn(),
          inspect: async () => null,
          forceRelease: async (_nonce: string) => false,
        };
      },

      createVerifier: () => ({
        verify: async () => {
          const start = performance.now();
          try {
            // Check remote endpoint accessibility
            const response = await fetch(`${parsed.endpoint}/health`);
            return {
              healthy: response.ok,
              message: response.ok ? "OK" : `HTTP ${response.status}`,
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@myorg/remote-store",
              details: {
                endpoint: parsed.endpoint,
                bucket: parsed.bucket,
                region: parsed.region,
              },
            };
          } catch (error) {
            return {
              healthy: false,
              message: String(error),
              latencyMs: Math.round(performance.now() - start),
              datastoreType: "@myorg/remote-store",
            };
          }
        },
      }),

      // Sync service for pull/push operations.
      //
      // The pattern below shows the per-key fast path enabled by
      // markDirty's options.relPath: maintain a Set<string> of dirty
      // relPaths plus a bulkInvalidated boolean. pushChanged consumes
      // the set when bulkInvalidated is false, doing exactly the work
      // core attributed; otherwise it falls back to a full walk. See
      // `design/datastores.md` "markDirty() contract" for the eight
      // load-bearing rules — pre-write timing, absence-on-disk = delete,
      // restart-loses-set, etc.
      //
      // For a no-op fallback (always do a full walk on every push),
      // delete the dirty set and just `return Promise.resolve()` from
      // markDirty.
      createSyncService: (_repoDir: string, cachePath: string) => {
        const dirty = new Set<string>();
        let bulkInvalidated = false;

        return {
          pullChanged: async () => {
            // Download changed files from remote to cachePath
            console.log(`Pulling from ${parsed.endpoint} to ${cachePath}`);
          },
          pushChanged: async () => {
            if (bulkInvalidated || dirty.size === 0) {
              // Full walk path — bulk signal arrived, or nothing recorded
              // (e.g. fresh process — see rule 4: "process restart loses
              // the set; first pushChanged after start does a full walk").
              console.log(`Full-walk push from ${cachePath}`);
            } else {
              for (const relPath of dirty) {
                // Wire format is forward-slash; convert to native path
                // before disk access (rule 5).
                const absPath = join(cachePath, ...relPath.split("/"));
                try {
                  await Deno.stat(absPath);
                  // upsert remote record for relPath (file exists)
                } catch (err) {
                  if (err instanceof Deno.errors.NotFound) {
                    // delete remote record (absence-on-disk = delete,
                    // rule 2 — collapses create/update/delete into one
                    // signal, no op-kind param needed).
                  } else throw err;
                }
              }
            }
            dirty.clear();
            bulkInvalidated = false;
          },
          markDirty: ({ relPath } = {}) => {
            // Pre-write timing (rule 1): the file isn't on disk yet.
            // We only RECORD the path; the upload happens later in
            // pushChanged.
            if (relPath !== undefined) {
              dirty.add(relPath);
            } else {
              // undefined = bulk (rule 3). Some core mutations also
              // emit a bulk + per-path pair from one operation
              // (rule 8) — bulk overrides any per-path entries we may
              // have recorded for the same operation.
              bulkInvalidated = true;
            }
            return Promise.resolve();
          },
        };
      },

      resolveDatastorePath: (repoDir: string) => {
        // For remote datastores, return the cache path
        return `${repoDir}/.swamp/remote-cache`;
      },

      resolveCachePath: (repoDir: string) => {
        return `${repoDir}/.swamp/remote-cache`;
      },
    };
  },
};
```

### `.swamp.yaml` config

```yaml
datastore:
  type: "@myorg/remote-store"
  config:
    endpoint: "https://storage.example.com"
    bucket: "my-automation-data"
    region: "us-west-2"
```

### Environment variable

```bash
export SWAMP_DATASTORE='@myorg/remote-store:{"endpoint":"https://storage.example.com","bucket":"my-data","region":"us-west-2"}'
```
