# Extension Model Examples

## Data Model (Ephemeral Output)

```typescript
// extensions/models/text_processor.ts
import { z } from "npm:zod@4";

const InputSchema = z.object({
  text: z.string(),
  operation: z.enum(["uppercase", "lowercase", "reverse"]),
});

const DataSchema = z.object({
  originalText: z.string(),
  processedText: z.string(),
  operation: z.string(),
  processedAt: z.string(),
});

export const model = {
  type: "myorg/text-processor",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataAttributesSchema: DataSchema,
  methods: {
    process: {
      description: "Process text according to the specified operation",
      execute: async (input, _context) => {
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

        return {
          data: {
            id: input.id,
            attributes: {
              originalText: text,
              processedText,
              operation,
              processedAt: new Date().toISOString(),
            },
          },
        };
      },
    },
  },
};
```

## Resource Model (Persistent Output)

```typescript
// extensions/models/deployment.ts
import { z } from "npm:zod@4";

const InputSchema = z.object({
  appName: z.string(),
  version: z.string(),
  environment: z.enum(["dev", "staging", "prod"]).default("dev"),
  replicas: z.number().min(1).max(10).default(1),
});

const ResourceSchema = z.object({
  deploymentId: z.string(),
  appName: z.string(),
  version: z.string(),
  environment: z.string(),
  replicas: z.number(),
  status: z.enum(["pending", "deployed", "failed"]),
  deployedAt: z.string(),
});

export const model = {
  type: "myorg/deployment",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  resourceAttributesSchema: ResourceSchema,
  methods: {
    deploy: {
      description: "Deploy the application",
      execute: async (input, _context) => {
        const attrs = input.attributes;
        const deploymentId = `deploy-${attrs.appName}-${Date.now()}`;

        return {
          resource: {
            id: input.id,
            attributes: {
              deploymentId,
              appName: attrs.appName,
              version: attrs.version,
              environment: attrs.environment ?? "dev",
              replicas: attrs.replicas ?? 1,
              status: "deployed",
              deployedAt: new Date().toISOString(),
            },
          },
        };
      },
    },
    scale: {
      description: "Scale the deployment replicas",
      execute: async (input, _context) => {
        const attrs = input.attributes;

        return {
          resource: {
            id: input.id,
            attributes: {
              deploymentId: `deploy-${attrs.appName}-scaled`,
              appName: attrs.appName,
              version: attrs.version,
              environment: attrs.environment ?? "dev",
              replicas: attrs.replicas ?? 1,
              status: "deployed",
              deployedAt: new Date().toISOString(),
            },
          },
        };
      },
    },
  },
};
```

## Minimal Data Model

```typescript
// extensions/models/echo.ts
import { z } from "npm:zod@4";

const InputSchema = z.object({ message: z.string() });
const DataSchema = z.object({ message: z.string(), timestamp: z.string() });

export const model = {
  type: "myorg/echo",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataAttributesSchema: DataSchema,
  methods: {
    run: {
      description: "Echo the message with timestamp",
      execute: async (input, _context) => ({
        data: {
          id: input.id,
          attributes: {
            message: input.attributes.message,
            timestamp: new Date().toISOString(),
          },
        },
      }),
    },
  },
};
```

## Data Chaining Model

Models that produce data can be chained together using CEL expressions. The
output from one model's `data.attributes` can be referenced by another model.

```typescript
// extensions/models/config_generator.ts
import { z } from "npm:zod@4";

const InputSchema = z.object({
  environment: z.enum(["dev", "staging", "prod"]),
  serviceName: z.string(),
});

const DataSchema = z.object({
  configJson: z.object({
    endpoint: z.string(),
    timeout: z.number(),
    retries: z.number(),
  }),
  generatedAt: z.string(),
});

export const model = {
  type: "myorg/config-generator",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataAttributesSchema: DataSchema,
  methods: {
    generate: {
      description: "Generate service configuration based on environment",
      execute: async (input, _context) => {
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

        return {
          data: {
            id: input.id,
            attributes: {
              configJson: {
                endpoint,
                timeout: envConfig.timeout,
                retries: envConfig.retries,
              },
              generatedAt: new Date().toISOString(),
            },
          },
        };
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

## Extending Existing Model Types

### Single Method Extension

```typescript
// extensions/models/echo_audit.ts
export const extension = {
  type: "swamp/echo",
  methods: [{
    audit: {
      description: "Audit the echo message",
      execute: async (definition, _context) => ({
        data: {
          attributes: {
            audited: true,
            name: definition.name,
            auditedAt: new Date().toISOString(),
          },
          name: "audit-result",
        },
      }),
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
      execute: async (definition, _context) => ({
        data: {
          attributes: { audited: true, name: definition.name },
          name: "audit-result",
        },
      }),
    },
    validate: {
      description: "Validate the echo message format",
      execute: async (definition, _context) => ({
        data: {
          attributes: {
            valid: definition.attributes.message.length > 0,
            length: definition.attributes.message.length,
          },
          name: "validation-result",
        },
      }),
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
