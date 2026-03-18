# Examples — Extension Datastores

## Minimal Local Datastore

A simple local filesystem variant that stores data in a custom directory:

```typescript
// extensions/datastores/custom-fs/mod.ts
import { z } from "npm:zod@4";

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

      // Sync service for pull/push operations
      createSyncService: (_repoDir: string, cachePath: string) => ({
        pullChanged: async () => {
          // Download changed files from remote to cachePath
          console.log(`Pulling from ${parsed.endpoint} to ${cachePath}`);
        },
        pushChanged: async () => {
          // Upload changed files from cachePath to remote
          console.log(`Pushing from ${cachePath} to ${parsed.endpoint}`);
        },
      }),

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
