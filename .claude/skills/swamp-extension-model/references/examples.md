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
  version: 1,
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
  version: 1,
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
  version: 1,
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
