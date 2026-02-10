# Extension Model Examples

## Text Processor Model

```typescript
// extensions/models/text_processor.ts
import { z } from "npm:zod@4";

const InputSchema = z.object({
  text: z.string(),
  operation: z.enum(["uppercase", "lowercase", "reverse"]),
});

export const model = {
  type: "@user/text-processor",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Processed text output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    process: {
      description: "Process text according to the specified operation",
      execute: async (input, context) => {
        const { text, operation } = input.attributes;

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

        const writer = context.createDataWriter!({
          name: "result",
          specType: "data",
        });
        const handle = await writer.writeText(JSON.stringify({
          originalText: text,
          processedText,
          operation,
          processedAt: new Date().toISOString(),
        }));
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

export const model = {
  type: "@user/deployment",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataOutputSpecs: {
    "resource": {
      specType: "resource",
      description: "Deployment resource state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource" },
    },
  },
  methods: {
    deploy: {
      description: "Deploy the application",
      execute: async (input, context) => {
        const attrs = input.attributes;
        const deploymentId = `deploy-${attrs.appName}-${Date.now()}`;

        const writer = context.createDataWriter!({
          name: "resource",
          specType: "resource",
        });
        const handle = await writer.writeText(JSON.stringify({
          deploymentId,
          appName: attrs.appName,
          version: attrs.version,
          environment: attrs.environment ?? "dev",
          replicas: attrs.replicas ?? 1,
          status: "deployed",
          deployedAt: new Date().toISOString(),
        }));
        return { dataHandles: [handle] };
      },
    },
    scale: {
      description: "Scale the deployment replicas",
      execute: async (input, context) => {
        const attrs = input.attributes;

        const writer = context.createDataWriter!({
          name: "resource",
          specType: "resource",
        });
        const handle = await writer.writeText(JSON.stringify({
          deploymentId: `deploy-${attrs.appName}-scaled`,
          appName: attrs.appName,
          version: attrs.version,
          environment: attrs.environment ?? "dev",
          replicas: attrs.replicas ?? 1,
          status: "deployed",
          deployedAt: new Date().toISOString(),
        }));
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

export const model = {
  type: "@user/echo",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Echo output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Echo the message with timestamp",
      execute: async (input, context) => {
        const writer = context.createDataWriter!({
          name: "data",
          specType: "data",
        });
        const handle = await writer.writeText(JSON.stringify({
          message: input.attributes.message,
          timestamp: new Date().toISOString(),
        }));
        return { dataHandles: [handle] };
      },
    },
  },
};
```

## Data Chaining Model

Models that produce data can be chained together using CEL expressions. The
output from one model's data can be referenced by another model.

```typescript
// extensions/models/config_generator.ts
import { z } from "npm:zod@4";

const InputSchema = z.object({
  environment: z.enum(["dev", "staging", "prod"]),
  serviceName: z.string(),
});

export const model = {
  type: "@user/config-generator",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Generated configuration",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    generate: {
      description: "Generate service configuration based on environment",
      execute: async (input, context) => {
        const { environment, serviceName } = input.attributes;

        // Generate environment-specific configuration
        const configs = {
          dev: { timeout: 30000, retries: 1 },
          staging: { timeout: 15000, retries: 2 },
          prod: { timeout: 5000, retries: 3 },
        };

        const envConfig = configs[environment];
        const endpoint =
          `https://${serviceName}.${environment}.example.com/api`;

        const writer = context.createDataWriter!({
          name: "config",
          specType: "data",
        });
        const handle = await writer.writeText(JSON.stringify({
          configJson: {
            endpoint,
            timeout: envConfig.timeout,
            retries: envConfig.retries,
          },
          generatedAt: new Date().toISOString(),
        }));
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
attributes:
  # Reference the generated config from another model's data output
  endpoint: ${{ model.api-config.data.attributes.configJson.endpoint }}
  timeout: ${{ model.api-config.data.attributes.configJson.timeout }}
  retries: ${{ model.api-config.data.attributes.configJson.retries }}
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

export const model = {
  type: "myorg/system-info",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  methods: {
    run: {
      description: "Run a system command with streamed output",
      execute: async (definition, context) => {
        const attrs = definition.attributes;

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

        return {
          data: {
            attributes: {
              stdout: result.stdout,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
            },
            name: "output",
          },
        };
      },
    },
  },
};
```

## Extending Existing Model Types

### Single Method Extension

```typescript
// extensions/models/echo_audit.ts
export const extension = {
  type: "swamp/echo",
  methods: [{
    audit: {
      description: "Audit the echo message",
      execute: async (definition, context) => {
        // Extensions use the target model's dataOutputSpecs
        const writer = context.createDataWriter!({
          name: "audit-result",
          specType: "data",
        });
        const handle = await writer.writeText(JSON.stringify({
          audited: true,
          name: definition.name,
          auditedAt: new Date().toISOString(),
        }));
        return { dataHandles: [handle] };
      },
    },
  }],
};
```

### Multiple Methods in One Extension File

```typescript
// extensions/models/echo_extras.ts
export const extension = {
  type: "swamp/echo",
  methods: [{
    audit: {
      description: "Audit the echo message",
      execute: async (definition, context) => {
        const writer = context.createDataWriter!({
          name: "audit-result",
          specType: "data",
        });
        const handle = await writer.writeText(JSON.stringify({
          audited: true,
          name: definition.name,
        }));
        return { dataHandles: [handle] };
      },
    },
    validate: {
      description: "Validate the echo message format",
      execute: async (definition, context) => {
        const writer = context.createDataWriter!({
          name: "validation-result",
          specType: "data",
        });
        const handle = await writer.writeText(JSON.stringify({
          valid: definition.attributes.message.length > 0,
          length: definition.attributes.message.length,
        }));
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
