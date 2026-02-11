# Extension Model Examples

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

        const handle = await context.writeResource!("result", "result", {
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

        const handle = await context.writeResource!("state", "state", {
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

        const handle = await context.writeResource!("state", "state", {
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
        const handle = await context.writeResource!("data", "data", {
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

        const handle = await context.writeResource!("config", "config", {
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

        const handle = await context.writeResource!("output", "output", {
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

## Extending Existing Model Types

### Single Method Extension

```typescript
// extensions/models/echo_audit.ts
import { z } from "npm:zod@4";

export const extension = {
  type: "swamp/echo",
  methods: [{
    audit: {
      description: "Audit the echo message",
      arguments: z.object({}),
      execute: async (args, context) => {
        // Extensions use the target model's resources/files
        const handle = await context.writeResource!("message", "message", {
          message: `Audited: ${context.definition.name}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  }],
};
```

### Multiple Methods in One Extension File

```typescript
// extensions/models/echo_extras.ts
import { z } from "npm:zod@4";

export const extension = {
  type: "swamp/echo",
  methods: [{
    audit: {
      description: "Audit the echo message",
      arguments: z.object({}),
      execute: async (args, context) => {
        const handle = await context.writeResource!("message", "message", {
          message: `Audited: ${context.definition.name}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    validate: {
      description: "Validate the echo message format",
      arguments: z.object({}),
      execute: async (args, context) => {
        const handle = await context.writeResource!("message", "message", {
          message: `Valid: ${context.globalArgs.message.length > 0}`,
          timestamp: new Date().toISOString(),
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
  echo_audit.ts           # export const extension (extends swamp/echo)
```
