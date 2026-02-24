# Extension Model Examples

## Table of Contents

- [CRUD Lifecycle Model (VPC)](#crud-lifecycle-model-vpc)
- [Text Processor Model](#text-processor-model)
- [Deployment Model](#deployment-model)
- [Minimal Echo Model](#minimal-echo-model)
- [Data Chaining Model](#data-chaining-model)
- [Shell Command with Streamed Logging](#shell-command-with-streamed-logging)
- [AWS Model with Pre-flight Credential Check](#aws-model-with-pre-flight-credential-check)
- [Using External Dependencies](#using-external-dependencies)
- [Extending Existing Model Types](#extending-existing-model-types)

## Using External Dependencies

Extension models are written in TypeScript and can import any package using
Deno's import specifiers: `npm:`, `jsr:`, or `https://` URLs. Swamp
automatically bundles the TypeScript source and all dependencies into a single
JavaScript file at startup — no install step required.

The bundler resolves and inlines all dependencies except `zod`, which is shared
with swamp to preserve schema `instanceof` checks.

```typescript
// extensions/models/text_analyzer.ts
import { z } from "npm:zod@4";
import { countBy, sortBy, words } from "npm:lodash-es";

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
  TypeScript and resolve all `npm:` imports into a single `.js` file
- The bundle is cached to `.swamp/bundles/` — subsequent runs skip bundling
  unless the source file's modification time is newer than the cached bundle
- `npm:zod` is externalized (not bundled) so your model shares the same zod
  instance as swamp, which is required for schema validation to work
- All other npm imports are fully resolved and inlined into the bundle

**Import rules:**

| Import                                   | Bundled? | Notes                            |
| ---------------------------------------- | -------- | -------------------------------- |
| `npm:zod@4`                              | No       | Shared with swamp (externalized) |
| `npm:lodash-es`                          | Yes      | Resolved and inlined             |
| `npm:@aws-sdk/client-s3`                 | Yes      | Resolved and inlined             |
| `jsr:@std/path`                          | Yes      | Resolved and inlined             |
| `https://deno.land/std@0.224.0/async/..` | Yes      | Resolved and inlined             |
| Any other Deno-compatible import         | Yes      | Resolved and inlined             |

## CRUD Lifecycle Model (VPC)

Models that manage real resources typically have `create`, `update`, and
`delete` methods. Each method follows a distinct pattern:

- **`create`** — runs a command, stores the result via `writeResource()`
- **`update`** — reads stored data to get the resource ID, modifies the
  resource, writes updated state via `writeResource()` (creates a new version)
- **`delete`** — reads stored data to get the resource ID, cleans up, returns
  `{ dataHandles: [] }`

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
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "vpc",
        );

        if (!content) {
          throw new Error("No VPC data found - run create first");
        }

        const existingData = JSON.parse(new TextDecoder().decode(content));
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
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "vpc",
        );

        if (!content) {
          throw new Error("No VPC data found - nothing to delete");
        }

        const vpcData = JSON.parse(new TextDecoder().decode(content));
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
  },
};
```

**Key points:**

- `create` stores data via `writeResource` — makes it available to other models
  via CEL expressions and to update/delete methods via `dataRepository`
- `update` reads stored data, modifies the resource, writes updated state via
  `writeResource` (creates a new version)
- `delete` reads stored data via `context.dataRepository.getContent()` using
  `context.modelType` and `context.modelId` to locate the model's own data
- `delete` returns `{ dataHandles: [] }` since no new data is produced
- Always check for `null` content — the model may not have been created yet

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
