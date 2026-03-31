# Extension Model Examples

## Table of Contents

- [CRUD Lifecycle Model (VPC)](#crud-lifecycle-model-vpc)
- [Polling to Completion](#polling-to-completion)
- [Idempotent Creates](#idempotent-creates)
- [Sync Method](#sync-method)
- [Error Handling Model](#error-handling-model)
- [Text Processor Model](#text-processor-model)
- [Deployment Model](#deployment-model)
- [Minimal Echo Model](#minimal-echo-model)
- [Data Chaining Model](#data-chaining-model)
- [Shell Command with Streamed Logging](#shell-command-with-streamed-logging)
- [AWS Model with Pre-flight Credential Check](#aws-model-with-pre-flight-credential-check)
- [Using External Dependencies](#using-external-dependencies)
- [Extending Existing Model Types](#extending-existing-model-types)
- [Helper Scripts](#helper-scripts)
- [Model with Version Upgrades](#model-with-version-upgrades)

## Using External Dependencies

Extension models are written in TypeScript and can import any package using
Deno's import specifiers: `npm:`, `jsr:`, or `https://` URLs. Swamp
automatically bundles the TypeScript source and all dependencies into a single
JavaScript file at startup — no install step required.

The bundler resolves and inlines all dependencies except `zod`, which is shared
with swamp to preserve schema `instanceof` checks.

### Import styles

There are two ways to declare dependencies:

**Inline imports** (no `deno.json` required):

```typescript
import { z } from "npm:zod@4.3.6";
import { countBy } from "npm:lodash-es@4.17.21";
```

**Import map** (requires `deno.json` alongside `manifest.yaml`):

```jsonc
// deno.json
{
  "imports": {
    "zod": "npm:zod@4.3.6",
    "lodash-es": "npm:lodash-es@4.17.21"
  }
}
```

```typescript
import { z } from "zod";
import { countBy } from "lodash-es";
```

**package.json** (for extensions inside existing Node/TypeScript projects):

```json
{
  "dependencies": {
    "zod": "4.3.6",
    "lodash-es": "4.17.21"
  }
}
```

```typescript
import { z } from "zod";
import { countBy } from "lodash-es";
```

Requires `node_modules/` to exist — run `npm install` or `deno install` before
pushing. Swamp only uses the `package.json` when the extension source has bare
specifiers; extensions with `npm:` prefixed imports are unaffected by an
unrelated `package.json` in the project tree.

The import map and package.json approaches are preferred for extensions that
want to use standard tooling (testing, linting, formatting) with their own
project configuration. All three styles produce identical bundles.

### Example

```typescript
// extensions/models/text_analyzer.ts
import { z } from "npm:zod@4";
import { countBy, sortBy, words } from "npm:lodash-es@4.17.21";

const GlobalArgsSchema = z.object({
  text: z.string().describe("Text to analyze"),
});

const AnalysisSchema = z.object({
  wordCount: z.number(),
  topWords: z.array(z.object({
    word: z.string(),
    count: z.number(),
  })),
  analyzedAt: z.string(),
});

export const model = {
  type: "@user/text-analyzer",
  version: "2026.02.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "analysis": {
      description: "Text analysis results",
      schema: AnalysisSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    analyze: {
      description: "Analyze word frequency in the text",
      arguments: z.object({
        topN: z.number().default(5),
      }),
      execute: async (args, context) => {
        const allWords = words(context.globalArgs.text.toLowerCase());
        const counts = countBy(allWords);
        const sorted = sortBy(
          Object.entries(counts).map(([word, count]) => ({ word, count })),
          (entry) => -entry.count,
        );

        const handle = await context.writeResource("analysis", "analysis", {
          wordCount: allWords.length,
          topWords: sorted.slice(0, args.topN),
          analyzedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

**How bundling works:**

- On first run (or after editing), swamp runs `deno bundle` to transpile your
  TypeScript into a `.js` file
- The bundle is cached to `.swamp/bundles/` — subsequent runs skip bundling
  unless the source file's modification time is newer than the cached bundle
- All `npm:` packages except `zod` are **inlined** into the bundle — they are
  resolved and included at bundle time, which ensures they work in the compiled
  binary where only swamp's own embedded dependency graph is available
- `zod` is externalized so your model shares the same zod instance as swamp,
  which is required for schema `instanceof` checks to work
- Local `.ts` code and other imports are still transpiled and bundled
- **Dynamic `import()` calls are not supported** — use static top-level imports
  only. The bundler cannot correctly handle CJS/ESM interop for dynamically
  imported packages.

**Import rules:**

| Import                                   | Bundled? | Notes                                    |
| ---------------------------------------- | -------- | ---------------------------------------- |
| `npm:zod@4`                              | No       | Externalized, shares instance with swamp |
| `npm:lodash-es@4.17.21`                  | Yes      | Inlined into the bundle                  |
| `npm:@aws-sdk/client-s3@3.750.0`         | Yes      | Inlined into the bundle                  |
| `jsr:@std/path`                          | Yes      | Resolved and inlined                     |
| `https://deno.land/std@0.224.0/async/..` | Yes      | Resolved and inlined                     |
| Local `.ts` imports                      | Yes      | Transpiled and inlined                   |
| `await import("npm:pkg")`                | N/A      | **Not supported** — use static imports   |

## CRUD Lifecycle Model (VPC)

Models that manage real resources typically have `create`, `update`, `delete`,
and `sync` methods. Each method follows a distinct pattern:

- **`create`** — runs a command, stores the result via `writeResource()`
- **`update`** — reads stored data to get the resource ID, modifies the
  resource, writes updated state via `writeResource()` (creates a new version)
- **`delete`** — reads stored data to get the resource ID, cleans up, returns
  `{ dataHandles: [] }`
- **`sync`** — reads stored data to get the resource ID, calls the live API to
  get current state, writes refreshed state (or marks as `not_found`)

```typescript
// extensions/models/vpc.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  cidrBlock: z.string(),
  region: z.string().default("us-east-1"),
});

const VpcSchema = z.object({
  VpcId: z.string(),
}).passthrough();

type VpcData = z.infer<typeof VpcSchema>;

export const model = {
  type: "@user/vpc",
  version: "2026.02.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "vpc": {
      description: "VPC resource state",
      schema: VpcSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create a VPC",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { cidrBlock, region } = context.globalArgs;

        const cmd = new Deno.Command("aws", {
          args: [
            "ec2",
            "create-vpc",
            "--cidr-block",
            cidrBlock,
            "--region",
            region,
            "--output",
            "json",
          ],
          stdout: "piped",
          stderr: "piped",
        });
        const output = await cmd.output();
        const vpcData = JSON.parse(new TextDecoder().decode(output.stdout)).Vpc;

        const handle = await context.writeResource("vpc", "vpc", vpcData);
        return { dataHandles: [handle] };
      },
    },
    update: {
      description: "Update VPC attributes (e.g., enable DNS support)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const region = context.globalArgs.region;

        // 1. Read stored data to get the resource ID
        const existingData = await context.readResource!("vpc") as
          | VpcData
          | null;

        if (!existingData) {
          throw new Error("No VPC data found - run create first");
        }

        const vpcId = existingData.VpcId;

        // 2. Modify the resource
        const modifyCmd = new Deno.Command("aws", {
          args: [
            "ec2",
            "modify-vpc-attribute",
            "--vpc-id",
            vpcId,
            "--enable-dns-support",
            '{"Value": true}',
            "--region",
            region,
          ],
          stdout: "piped",
          stderr: "piped",
        });
        await modifyCmd.output();

        // 3. Describe to get current state
        const describeCmd = new Deno.Command("aws", {
          args: [
            "ec2",
            "describe-vpcs",
            "--vpc-ids",
            vpcId,
            "--region",
            region,
            "--output",
            "json",
          ],
          stdout: "piped",
          stderr: "piped",
        });
        const describeOutput = await describeCmd.output();
        const updatedData = JSON.parse(
          new TextDecoder().decode(describeOutput.stdout),
        ).Vpcs[0];

        // 4. Write updated state — creates a new version of the resource
        const handle = await context.writeResource("vpc", "vpc", updatedData);
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Delete the VPC",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const region = context.globalArgs.region;

        // Read back stored data to get the VPC ID
        const vpcData = await context.readResource!("vpc") as VpcData | null;

        if (!vpcData) {
          throw new Error("No VPC data found - nothing to delete");
        }

        const vpcId = vpcData.VpcId;

        const cmd = new Deno.Command("aws", {
          args: [
            "ec2",
            "delete-vpc",
            "--vpc-id",
            vpcId,
            "--region",
            region,
          ],
          stdout: "piped",
          stderr: "piped",
        });
        await cmd.output();

        // Return empty dataHandles — resource is gone
        return { dataHandles: [] };
      },
    },
    sync: {
      description: "Refresh stored VPC state from live AWS API",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const region = context.globalArgs.region;

        // 1. Read stored data to get the VPC ID
        const existingData = await context.readResource!("vpc") as
          | VpcData
          | null;

        if (!existingData) {
          throw new Error("No VPC data found - run create first");
        }

        const vpcId = existingData.VpcId;

        // 2. Call the live API to get current state
        const describeCmd = new Deno.Command("aws", {
          args: [
            "ec2",
            "describe-vpcs",
            "--vpc-ids",
            vpcId,
            "--region",
            region,
            "--output",
            "json",
          ],
          stdout: "piped",
          stderr: "piped",
        });
        const output = await describeCmd.output();

        if (!output.success) {
          const error = new TextDecoder().decode(output.stderr);
          // 3. Resource gone — write not_found marker
          if (error.includes("InvalidVpcID.NotFound")) {
            const handle = await context.writeResource("vpc", "vpc", {
              VpcId: vpcId,
              status: "not_found",
              syncedAt: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }
          throw new Error(error);
        }

        // 4. Write refreshed state from live API
        const liveData = JSON.parse(
          new TextDecoder().decode(output.stdout),
        ).Vpcs[0];
        const handle = await context.writeResource("vpc", "vpc", liveData);
        return { dataHandles: [handle] };
      },
    },
  },
};
```

**Key points:**

- `create` stores data via `writeResource` — makes it available to other models
  via CEL expressions and to update/delete/sync methods via `dataRepository`
- `update` reads stored data, modifies the resource, writes updated state via
  `writeResource` (creates a new version)
- `delete` reads stored data via `context.readResource()` to locate the model's
  own data
- `delete` returns `{ dataHandles: [] }` since no new data is produced
- `sync` reads the stored resource ID (zero-arg — no user input needed), calls
  the live API, and writes refreshed state or a `not_found` marker for drift
  detection
- Always check for `null` content — the model may not have been created yet

## Polling to Completion

When integrating with cloud providers or async APIs, the create/update response
often contains provisional state (e.g., `"ip": "pending"`, `"status": "new"`).
If other models reference attributes that aren't populated until the resource is
ready, consider polling until fully provisioned before returning. This ensures
`writeResource()` stores complete data, so downstream CEL expressions resolve to
real values — not placeholders.

Not every model needs polling — if the API returns complete state synchronously,
or no other model depends on post-provisioning attributes, you can skip it. When
building a new extension model, swamp will ask whether you want to include
polling support.

### Helpers: Retry and Poll

Extract reusable helpers into a `_lib/` directory so all models for the same
provider share them:

```typescript
// extensions/models/_lib/provider.ts

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if an error is retryable (throttling, rate limits, transient). */
function isRetryable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("Throttling") ||
    msg.includes("TooManyRequests") ||
    msg.includes("rate limit") ||
    msg.includes("429")
  );
}

/**
 * Retry an operation with exponential backoff on throttling errors.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxAttempts = 20,
): Promise<T> {
  const baseDelay = 1000;
  const maxDelay = 90000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (isRetryable(error) && attempt < maxAttempts - 1) {
        const exponentialDelay = Math.min(
          baseDelay * Math.pow(2, attempt),
          maxDelay,
        );
        const jitter = Math.random() * 0.3 * exponentialDelay;
        console.log(
          `[${operationName}] Retryable error on attempt ${attempt + 1}, ` +
            `waiting ${Math.round(exponentialDelay + jitter)}ms`,
        );
        await delay(exponentialDelay + jitter);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`${operationName} failed after ${maxAttempts} attempts`);
}

/**
 * Poll a status function until it returns a terminal state.
 * Returns the final status result.
 */
export async function pollUntilReady<T>(
  checkStatus: () => Promise<{ done: boolean; result: T; error?: string }>,
  operationName: string,
  maxPolls = 60,
): Promise<T> {
  const baseDelay = 1000;
  const maxDelay = 90000;

  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const status = await checkStatus();

    if (status.error) {
      throw new Error(`${operationName} failed: ${status.error}`);
    }
    if (status.done) {
      return status.result;
    }

    const exponentialDelay = Math.min(
      baseDelay * Math.pow(2, attempt),
      maxDelay,
    );
    const jitter = Math.random() * 0.3 * exponentialDelay;
    console.log(
      `[${operationName}] In progress, waiting ` +
        `${Math.round(exponentialDelay + jitter)}ms (poll ${attempt + 1})`,
    );
    await delay(exponentialDelay + jitter);
  }

  throw new Error(`${operationName} timed out after ${maxPolls} polls`);
}
```

### Using the Helpers in a Model

```typescript
// extensions/models/load_balancer.ts
import { z } from "npm:zod@4";
import { pollUntilReady, withRetry } from "./_lib/provider.ts";

const GlobalArgsSchema = z.object({
  name: z.string(),
  region: z.string().default("nyc1"),
  apiToken: z.string(),
});

const LBSchema = z.object({
  id: z.string(),
  name: z.string(),
  ip: z.string(),
  status: z.string(),
}).passthrough();

async function apiCall(
  method: string,
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.example.com/v2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

export const model = {
  type: "@user/load-balancer",
  version: "2026.03.08.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "lb": {
      description: "Load balancer resource",
      schema: LBSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create a load balancer and wait until active",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { name, region, apiToken } = context.globalArgs;

        // 1. Call the create API
        const createResult = await withRetry(
          () =>
            apiCall("POST", "/load_balancers", apiToken, {
              name,
              region,
            }),
          "lb create",
        );

        const lbId = (createResult as { load_balancer: { id: string } })
          .load_balancer.id;
        console.log(`[CREATE] Load balancer ${lbId} created, polling...`);

        // 2. Poll until the resource reaches a ready state
        const readyLb = await pollUntilReady(
          async () => {
            const resp = await withRetry(
              () => apiCall("GET", `/load_balancers/${lbId}`, apiToken),
              "lb status check",
            );
            const lb = (resp as { load_balancer: Record<string, unknown> })
              .load_balancer;
            return {
              done: lb.status === "active",
              result: lb,
              error: lb.status === "errored"
                ? `Load balancer entered error state`
                : undefined,
            };
          },
          "lb create",
        );

        // 3. Store the fully-populated resource — IP is real, not "pending"
        const handle = await context.writeResource("lb", "main", readyLb);
        return { dataHandles: [handle] };
      },
    },
  },
};
```

**Key points:**

- The `create` method blocks until the load balancer is `active` — downstream
  CEL expressions like `data.latest("web-lb", "lb").attributes.ip` always
  resolve to the real IP, never `"pending"`
- `withRetry` handles transient errors (throttling, rate limits) with
  exponential backoff + jitter
- `pollUntilReady` handles async provisioning by checking a status endpoint
  until a terminal state is reached
- Shared helpers in `_lib/` avoid duplicating retry/poll logic across models for
  the same provider
- The same pattern applies to `update` and `delete` — always wait for the
  operation to finish before returning

## Idempotent Creates

When a workflow partially fails and is re-run, `create` methods execute again
for resources that were already successfully created. For non-idempotent APIs
(e.g., droplets, load balancers, EC2 instances), this creates duplicates.

Not every model needs this — if the provider's API is naturally idempotent
(e.g., "create tag" is a no-op if it exists), or if your model intentionally
creates multiple instances, you can skip the check. When building a new
extension model, swamp will ask whether you want to include idempotency support.

**When needed, the check belongs in the model, not in swamp core**, because:

- The model knows what the identifier field is called (`VpcId` vs `id` vs
  `slug`)
- The model knows how to verify existence (CloudControl GET vs REST
  `/v2/droplets/{id}`)
- The model knows whether the API is naturally idempotent (e.g., tags are,
  droplets aren't)

A generic `skip-if-data-exists` check in swamp would be fragile — stale data
from a deleted resource would cause it to skip creation entirely, leaving you
with no resource and no error.

### Pattern: Check Existing State Before Creating

```typescript
// extensions/models/droplet.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  name: z.string(),
  region: z.string().default("nyc1"),
  size: z.string().default("s-1vcpu-1gb"),
  image: z.string().default("ubuntu-24-04-x64"),
  apiToken: z.string(),
});

const DropletSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
}).passthrough();

type DropletData = z.infer<typeof DropletSchema>;

async function apiCall(
  method: string,
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.example.com/v2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("NOT_FOUND");
    }
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

export const model = {
  type: "@user/droplet",
  version: "2026.03.08.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "droplet": {
      description: "Droplet resource state",
      schema: DropletSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create a droplet (idempotent — skips if already exists)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { name, region, size, image, apiToken } = context.globalArgs;
        const instanceName = "main";

        // 1. Check if we already have state for this instance
        const existing = await context.readResource!(instanceName) as
          | DropletData
          | null;

        if (existing) {
          const id = existing.id;

          // 2. Verify the resource still exists at the provider
          try {
            const resp = await apiCall(
              "GET",
              `/droplets/${id}`,
              apiToken,
            );
            const current =
              (resp as { droplet: Record<string, unknown> }).droplet;
            console.log(
              `[CREATE] Droplet ${id} already exists, returning existing state`,
            );
            const handle = await context.writeResource(
              "droplet",
              instanceName,
              current,
            );
            return { dataHandles: [handle] };
          } catch (error) {
            // 3. Resource gone — stale data, fall through to create
            if (error instanceof Error && error.message === "NOT_FOUND") {
              console.log(
                `[CREATE] Stale state found for droplet ${id}, creating new`,
              );
            } else {
              throw error;
            }
          }
        }

        // 4. No existing state or resource gone — create normally
        const resp = await apiCall("POST", "/droplets", apiToken, {
          name,
          region,
          size,
          image,
        });
        const droplet = (resp as { droplet: Record<string, unknown> }).droplet;

        const handle = await context.writeResource(
          "droplet",
          instanceName,
          droplet,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
```

**Key points:**

- `context.readResource()` reads stored JSON data by instance name — returns
  parsed object or `null` if no data exists. Cast with `as YourType | null`
  using `z.infer<typeof YourSchema>` for type safety
- The idempotency check verifies the resource **still exists at the provider**,
  not just that local data exists — this prevents stale data from blocking
  creation after a resource is externally deleted
- Only catch `NOT_FOUND` errors from the verification GET — re-throw unexpected
  errors so they surface properly
- Combine with [polling to completion](#polling-to-completion) for the full
  pattern: idempotent create + poll until ready before returning

## Sync Method

Every CRUD model should include a `sync` method for drift detection. Unlike
`get` (which requires the user to provide the resource ID as an argument),
`sync` reads the ID from already-stored state, making it zero-arg. This means a
workflow can call `sync` on every instance without knowing resource IDs up
front.

`sync` does not throw when the resource is gone — it writes a `not_found`
marker. The purpose is detection, not failure.

### Pattern: Read Stored ID, Refresh from Live API

```typescript
sync: {
  description: "Refresh stored state from live API",
  arguments: z.object({}),
  execute: async (_args, context) => {
    const instanceName = "main";

    // 1. Read stored state to get the resource ID
    const state = await context.readResource!(instanceName);

    if (!state) {
      throw new Error("No stored state — run create first");
    }

    const id = state.id; // Adapt to your identifier field (VpcId, Name, etc.)

    // 2. Call the live API
    try {
      const resp = await apiCall("GET", `/resources/${id}`, token);
      const live = (resp as { resource: Record<string, unknown> }).resource;
      const handle = await context.writeResource("state", instanceName, live);
      return { dataHandles: [handle] };
    } catch (error) {
      // 3. Resource gone — write not_found marker for drift detection
      if (error instanceof Error && error.message === "NOT_FOUND") {
        const handle = await context.writeResource("state", instanceName, {
          id,
          status: "not_found",
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      }
      throw error;
    }
  },
},
```

### Orchestrating Sync Across Models

A "drift check" across your entire stack is a workflow — one step per model
calling `sync`. After running this, `swamp data list` shows the refreshed state
for everything, including which resources came back as `not_found`.

```yaml
# workflows/sync-all/workflow.yaml
name: sync-all
version: 1
jobs:
  - name: sync
    steps:
      - name: sync-vpc
        task:
          type: model_method
          modelIdOrName: web-vpc
          methodName: sync

      - name: sync-droplet-1
        task:
          type: model_method
          modelIdOrName: web-droplet
          methodName: sync
          inputs:
            name: web-1

      - name: sync-droplet-2
        task:
          type: model_method
          modelIdOrName: web-droplet
          methodName: sync
          inputs:
            name: web-2

      - name: sync-lb
        task:
          type: model_method
          modelIdOrName: web-lb
          methodName: sync
```

**Key points:**

- `sync` takes no method arguments — the resource ID comes from stored state
- Unlike `get`, which requires the user to provide the resource ID, `sync` is
  self-contained
- On success, `writeResource` refreshes stored state with live data
- On failure (resource gone), write a `not_found` marker so downstream logic can
  detect drift
- Enumerate instances with
  `swamp data query 'modelName == "<name>" && dataType == "resource"'` to
  discover what needs syncing (see `swamp-data-query` skill)

## Error Handling Model

Models should throw when execution fails. Throw **before** writing data — failed
executions should not persist incorrect or misleading data.

**Pattern: check for failure first, only write data on success.**

```typescript
// extensions/models/health_check.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  url: z.string().url(),
  expectedStatus: z.number().default(200),
});

const ResultSchema = z.object({
  url: z.string(),
  statusCode: z.number(),
  responseTimeMs: z.number(),
  checkedAt: z.string(),
});

export const model = {
  type: "@user/health-check",
  version: "2026.03.05.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Health check result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Check endpoint health",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { url, expectedStatus } = context.globalArgs;
        const start = Date.now();

        const response = await fetch(url);
        const responseTimeMs = Date.now() - start;

        // Throw BEFORE writing data — don't persist failure data
        if (response.status !== expectedStatus) {
          throw new Error(
            `Health check failed: expected status ${expectedStatus}, got ${response.status}`,
          );
        }

        const handle = await context.writeResource("result", "main", {
          url,
          statusCode: response.status,
          responseTimeMs,
          checkedAt: new Date().toISOString(),
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
```

**Key points:**

- Throw before `writeResource()` — failed executions should not write data
- The workflow engine catches the exception and marks the step as failed
- Use `allowFailure: true` on a workflow step to continue execution after a
  failure

## Text Processor Model

```typescript
// extensions/models/text_processor.ts
import { z } from "npm:zod@4";

const InputSchema = z.object({
  text: z.string(),
  operation: z.enum(["uppercase", "lowercase", "reverse"]),
});

const OutputSchema = z.object({
  originalText: z.string(),
  processedText: z.string(),
  operation: z.string(),
  processedAt: z.string(),
});

export const model = {
  type: "@user/text-processor",
  version: "2026.02.09.1",
  resources: {
    "result": {
      description: "Processed text output",
      schema: OutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    process: {
      description: "Process text according to the specified operation",
      arguments: InputSchema,
      execute: async (args, context) => {
        const { text, operation } = args;

        let processedText: string;
        switch (operation) {
          case "uppercase":
            processedText = text.toUpperCase();
            break;
          case "lowercase":
            processedText = text.toLowerCase();
            break;
          case "reverse":
            processedText = text.split("").reverse().join("");
            break;
        }

        const handle = await context.writeResource("result", "result", {
          originalText: text,
          processedText,
          operation,
          processedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

## Deployment Model

```typescript
// extensions/models/deployment.ts
import { z } from "npm:zod@4";

const InputSchema = z.object({
  appName: z.string(),
  version: z.string(),
  environment: z.enum(["dev", "staging", "prod"]).default("dev"),
  replicas: z.number().min(1).max(10).default(1),
});

const StateSchema = z.object({
  deploymentId: z.string(),
  appName: z.string(),
  version: z.string(),
  environment: z.string(),
  replicas: z.number(),
  status: z.string(),
  deployedAt: z.string(),
});

export const model = {
  type: "@user/deployment",
  version: "2026.02.09.1",
  globalArguments: InputSchema,
  resources: {
    "state": {
      description: "Deployment resource state",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    deploy: {
      description: "Deploy the application",
      arguments: z.object({}),
      execute: async (args, context) => {
        const attrs = context.globalArgs;
        const deploymentId = `deploy-${attrs.appName}-${Date.now()}`;

        const handle = await context.writeResource("state", "state", {
          deploymentId,
          appName: attrs.appName,
          version: attrs.version,
          environment: attrs.environment ?? "dev",
          replicas: attrs.replicas ?? 1,
          status: "deployed",
          deployedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    scale: {
      description: "Scale the deployment replicas",
      arguments: z.object({}),
      execute: async (args, context) => {
        const attrs = context.globalArgs;

        const handle = await context.writeResource("state", "state", {
          deploymentId: `deploy-${attrs.appName}-scaled`,
          appName: attrs.appName,
          version: attrs.version,
          environment: attrs.environment ?? "dev",
          replicas: attrs.replicas ?? 1,
          status: "deployed",
          deployedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

## Minimal Echo Model

```typescript
// extensions/models/echo.ts
import { z } from "npm:zod@4";

const InputSchema = z.object({ message: z.string() });

const OutputSchema = z.object({
  message: z.string(),
  timestamp: z.string(),
});

export const model = {
  type: "@user/echo",
  version: "2026.02.09.1",
  globalArguments: InputSchema,
  resources: {
    "data": {
      description: "Echo output",
      schema: OutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Echo the message with timestamp",
      arguments: z.object({}),
      execute: async (args, context) => {
        const handle = await context.writeResource("data", "data", {
          message: context.globalArgs.message,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

## Data Chaining Model

Models that produce data can be chained together using CEL expressions. The
output from one model's resource can be referenced by another model.

```typescript
// extensions/models/config_generator.ts
import { z } from "npm:zod@4";

const InputSchema = z.object({
  environment: z.enum(["dev", "staging", "prod"]),
  serviceName: z.string(),
});

const ConfigSchema = z.object({
  configJson: z.object({
    endpoint: z.string(),
    timeout: z.number(),
    retries: z.number(),
  }),
  generatedAt: z.string(),
});

export const model = {
  type: "@user/config-generator",
  version: "2026.02.09.1",
  globalArguments: InputSchema,
  resources: {
    "config": {
      description: "Generated configuration",
      schema: ConfigSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    generate: {
      description: "Generate service configuration based on environment",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { environment, serviceName } = context.globalArgs;

        // Generate environment-specific configuration
        const configs = {
          dev: { timeout: 30000, retries: 1 },
          staging: { timeout: 15000, retries: 2 },
          prod: { timeout: 5000, retries: 3 },
        };

        const envConfig = configs[environment];
        const endpoint =
          `https://${serviceName}.${environment}.example.com/api`;

        const handle = await context.writeResource("config", "config", {
          configJson: {
            endpoint,
            timeout: envConfig.timeout,
            retries: envConfig.retries,
          },
          generatedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

**Using the chained output in another model input:**

```yaml
# Model input that references config-generator output
name: my-service-client
globalArguments:
  # Reference the generated config from another model's resource output
  endpoint: ${{ model.api-config.resource.config.config.attributes.configJson.endpoint }}
  timeout: ${{ model.api-config.resource.config.config.attributes.configJson.timeout }}
  retries: ${{ model.api-config.resource.config.config.attributes.configJson.retries }}
```

This pattern enables dynamic configuration where one model generates values that
are consumed by dependent models, with the workflow engine automatically
resolving execution order based on expression dependencies.

## Shell Command with Streamed Logging

Use `executeProcess` with `context.logger` for shell commands. Output is
streamed line-by-line through LogTape — displayed on the console and persisted
to a `.log` file by `RunFileSink` automatically.

```typescript
// extensions/models/system_info.ts
import { z } from "npm:zod@4";
import { executeProcess } from "../../../../src/infrastructure/process/process_executor.ts";

const InputSchema = z.object({
  command: z.string().default("uname -a"),
  timeoutMs: z.number().optional(),
});

const OutputSchema = z.object({
  stdout: z.string(),
  exitCode: z.number(),
  durationMs: z.number(),
});

export const model = {
  type: "@myorg/system-info",
  version: "2026.02.09.1",
  globalArguments: InputSchema,
  resources: {
    "output": {
      description: "Command execution result",
      schema: OutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run a system command with streamed output",
      arguments: z.object({}),
      execute: async (args, context) => {
        const attrs = context.globalArgs;

        // executeProcess streams stdout (info) and stderr (warn) through
        // context.logger, which routes to console + run log file.
        const result = await executeProcess({
          command: "sh",
          args: ["-c", attrs.command],
          timeoutMs: attrs.timeoutMs,
          logger: context.logger,
        });

        if (!result.success) {
          throw new Error(
            `Command failed (exit ${result.exitCode}): ${result.stderr}`,
          );
        }

        const handle = await context.writeResource("output", "output", {
          stdout: result.stdout,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

## AWS Model with Pre-flight Credential Check

Models that call AWS APIs should validate credentials before doing real work.
This catches expired SSO sessions, missing profiles, and misconfigured
credentials early — with an actionable error message instead of a cryptic
failure mid-execution.

**Key patterns:**

- Add an optional `awsProfile` global argument for SSO/profile-based auth
- Create a helper that injects `--profile` and `--region` into every AWS CLI
  call
- Call `sts get-caller-identity` as a pre-flight check before any real work
- Include an `aws sso login` hint in the error message when a profile is
  configured

```typescript
// extensions/models/vpc.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  cidrBlock: z.string(),
  region: z.string().default("us-east-1"),
  awsProfile: z.string().optional(),
});

const VpcSchema = z.object({
  VpcId: z.string(),
}).passthrough();

/** Run an AWS CLI command, injecting profile if configured. */
async function awsCli(
  args: string[],
  globalArgs: { region: string; awsProfile?: string },
) {
  const fullArgs = [...args, "--region", globalArgs.region, "--output", "json"];
  if (globalArgs.awsProfile) {
    fullArgs.push("--profile", globalArgs.awsProfile);
  }
  const cmd = new Deno.Command("aws", {
    args: fullArgs,
    stdout: "piped",
    stderr: "piped",
  });
  return await cmd.output();
}

/** Validate AWS credentials before doing real work. */
async function validateCredentials(
  globalArgs: { region: string; awsProfile?: string },
) {
  const output = await awsCli(
    ["sts", "get-caller-identity"],
    globalArgs,
  );
  if (output.code !== 0) {
    const stderr = new TextDecoder().decode(output.stderr);
    const profileHint = globalArgs.awsProfile
      ? `\n  aws sso login --profile ${globalArgs.awsProfile}`
      : "";
    throw new Error(
      `AWS credential check failed: ${stderr.trim()}\n\n` +
        `Ensure your credentials are valid.${profileHint}`,
    );
  }
}

export const model = {
  type: "@user/vpc",
  version: "2026.02.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "vpc": {
      description: "VPC resource state",
      schema: VpcSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create a VPC",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { cidrBlock, region, awsProfile } = context.globalArgs;

        await validateCredentials({ region, awsProfile });

        const output = await awsCli(
          ["ec2", "create-vpc", "--cidr-block", cidrBlock],
          { region, awsProfile },
        );

        if (output.code !== 0) {
          const stderr = new TextDecoder().decode(output.stderr);
          throw new Error(`Failed to create VPC: ${stderr.trim()}`);
        }

        const vpcData = JSON.parse(new TextDecoder().decode(output.stdout)).Vpc;
        const handle = await context.writeResource("vpc", "vpc", vpcData);
        return { dataHandles: [handle] };
      },
    },
  },
};
```

**Why this works without framework changes:**

- Deno merges env vars with the parent environment, so `AWS_PROFILE` set in your
  shell is already available to subprocesses
- The AWS SDK credential chain handles SSO, `credential_process`, instance
  profiles, and role assumption automatically
- The model owns the pre-flight check logic because it is the domain expert for
  its service — it knows what credentials it needs and what a useful error looks
  like

## Extending Existing Model Types

### Single Method Extension

```typescript
// extensions/models/shell_audit.ts
import { z } from "npm:zod@4";

export const extension = {
  type: "command/shell",
  methods: [{
    audit: {
      description: "Audit the shell command execution",
      arguments: z.object({}),
      execute: async (args, context) => {
        // Extensions use the target model's resources/files
        const handle = await context.writeResource("result", "result", {
          exitCode: 0,
          command: `audit: ${context.definition.name}`,
          executedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  }],
};
```

### Multiple Methods in One Extension File

```typescript
// extensions/models/shell_extras.ts
import { z } from "npm:zod@4";

export const extension = {
  type: "command/shell",
  methods: [{
    audit: {
      description: "Audit the shell command execution",
      arguments: z.object({}),
      execute: async (args, context) => {
        const handle = await context.writeResource("result", "result", {
          exitCode: 0,
          command: `audit: ${context.definition.name}`,
          executedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    validate: {
      description: "Validate the shell command format",
      arguments: z.object({}),
      execute: async (args, context) => {
        const handle = await context.writeResource("result", "result", {
          exitCode: 0,
          command: `valid: ${context.globalArgs.run?.length > 0}`,
          executedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  }],
};
```

### Nested Directory Organization

Extension and model files can live in subdirectories for organization:

```
extensions/models/
  aws/
    s3_bucket.ts          # export const model (new type)
    s3_audit.ts           # export const extension (extends aws s3)
  monitoring/
    health_check.ts       # export const model (new type)
  shell_audit.ts          # export const extension (extends command/shell)
```

## Helper Scripts

When a model needs to shell out to a helper script that has dependencies swamp
can't bundle (e.g., native modules), use the `include` manifest field. Include
files are shipped alongside models but never bundled.

### Manifest

```yaml
manifestVersion: 1
name: "@myorg/homekit"
version: "2026.03.24.1"
models:
  - homekit.ts
include:
  - homekit_discover.ts
```

### Model (shells out to helper)

```typescript
// extensions/models/homekit.ts
import { z } from "npm:zod@4";

export const model = {
  type: "@myorg/homekit",
  version: "2026.03.24.1",
  globalArguments: z.object({}),
  methods: {
    discover: {
      description: "Discover HomeKit devices via mDNS",
      arguments: z.object({}),
      outputSpec: [{
        name: "devices",
        type: "resource",
        description: "Discovered devices",
      }],
      execute: async (_args: unknown, context: { repoDir: string }) => {
        const scriptPath =
          `${context.repoDir}/extensions/models/homekit_discover.ts`;
        const cmd = new Deno.Command("deno", {
          args: ["run", "--allow-net", scriptPath],
          stdout: "piped",
        });
        const output = await cmd.output();
        return { devices: new TextDecoder().decode(output.stdout) };
      },
    },
  },
};
```

### Helper (not a model, not bundled)

```typescript
// extensions/models/homekit_discover.ts
// This file does NOT export const model — swamp won't try to bundle it.
import { HAPController } from "npm:hap-controller@1.0.0";

const browser = new HAPController();
const devices = await browser.discover();
console.log(JSON.stringify(devices));
```

The loader skips files that don't declare `export const model` or
`export const extension`, so the helper is never bundled — even without the
`include` manifest field. The `include` field is needed to ship the helper in
the extension archive when publishing.

## Model with Version Upgrades

A notifier model that evolves through three versions, demonstrating how to
maintain an upgrade chain for existing instances.

```typescript
import { z } from "npm:zod@4";

export const model = {
  type: "@acme/notifier",
  version: "2026.02.09.1",

  globalArguments: z.object({
    content: z.string().min(1),
    priority: z.enum(["low", "medium", "high"]),
  }),

  resources: {
    "result": {
      description: "Notification result",
      schema: z.object({
        sent: z.boolean(),
        content: z.string(),
        priority: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  // Upgrade chain: each entry migrates from the previous version.
  // The last toVersion must match the model's current version.
  upgrades: [
    {
      toVersion: "2025.06.01.1",
      description: "Add priority field with default 'medium'",
      upgradeAttributes: (old) => ({
        ...old,
        priority: "medium",
      }),
    },
    {
      toVersion: "2026.02.09.1",
      description: "Rename 'message' to 'content'",
      upgradeAttributes: (old) => {
        const { message, ...rest } = old;
        return { ...rest, content: message };
      },
    },
  ],

  methods: {
    send: {
      description: "Send a notification",
      arguments: z.object({}),
      execute: async (args, context) => {
        const globalArgs = context.globalArgs;
        const handle = await context.writeResource("result", "main", {
          sent: true,
          content: globalArgs.content,
          priority: globalArgs.priority,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

An instance created at version `2025.01.15.1` with `{ message: "hello" }` will
automatically migrate when any method runs:

1. Upgrade to `2025.06.01.1`: `{ message: "hello", priority: "medium" }`
2. Upgrade to `2026.02.09.1`: `{ content: "hello", priority: "medium" }`
3. Definition persisted with `typeVersion: "2026.02.09.1"`
