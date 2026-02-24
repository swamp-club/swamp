# Extension Model Scenarios

End-to-end scenarios showing how to build custom extension models.

## Table of Contents

- [Scenario 1: Custom API Integration](#scenario-1-custom-api-integration)
- [Scenario 2: Cloud Resource CRUD](#scenario-2-cloud-resource-crud)
- [Scenario 3: Factory Model for Discovery](#scenario-3-factory-model-for-discovery)
- [Scenario 4: Extending Built-in Models](#scenario-4-extending-built-in-models)

---

## Scenario 1: Custom API Integration

### User Request

> "I need to integrate with a third-party API (like Stripe, Twilio, or a custom
> internal API) that doesn't have a built-in model type."

### What You'll Build

- 1 extension model: `@user/stripe-customer`
- Methods: `create`, `get`, `update`

### Decision Tree

```
No built-in model for this API → Create extension model
Need typed input validation → Define Zod schemas
Store response data for CEL access → Use writeResource
```

### Step-by-Step

**1. Create the model file**

```typescript
// extensions/models/stripe_customer.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  apiKey: z.string(), // Use: ${{ vault.get("stripe-vault", "API_KEY") }}
});

const CreateArgsSchema = z.object({
  email: z.string().email(),
  name: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const CustomerSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  created: z.number(),
}).passthrough();

export const model = {
  type: "@user/stripe-customer",
  version: "2026.02.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "customer": {
      description: "Stripe customer resource",
      schema: CustomerSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create a new Stripe customer",
      arguments: CreateArgsSchema,
      execute: async (args, context) => {
        const response = await fetch("https://api.stripe.com/v1/customers", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${context.globalArgs.apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            email: args.email,
            name: args.name,
            ...(args.metadata &&
              { "metadata[key]": JSON.stringify(args.metadata) }),
          }),
        });

        if (!response.ok) {
          throw new Error(`Stripe API error: ${response.statusText}`);
        }

        const customer = await response.json();

        const handle = await context.writeResource(
          "customer",
          "primary",
          customer,
        );
        return { dataHandles: [handle] };
      },
    },
    get: {
      description: "Get customer details",
      arguments: z.object({}),
      execute: async (_args, context) => {
        // Read stored customer ID
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "primary",
        );

        if (!content) {
          throw new Error("No customer found - run create first");
        }

        const stored = JSON.parse(new TextDecoder().decode(content));
        const customerId = stored.id;

        const response = await fetch(
          `https://api.stripe.com/v1/customers/${customerId}`,
          {
            headers: {
              Authorization: `Bearer ${context.globalArgs.apiKey}`,
            },
          },
        );

        const customer = await response.json();

        const handle = await context.writeResource(
          "customer",
          "primary",
          customer,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
```

**2. Create a model instance**

```bash
swamp model create @user/stripe-customer my-customer --json
```

**3. Configure with vault for API key**

```yaml
# models/my-customer/input.yaml
name: my-customer
version: 1
globalArguments:
  apiKey: ${{ vault.get("stripe-vault", "STRIPE_API_KEY") }}
methods:
  create:
    arguments:
      email: customer@example.com
      name: John Doe
```

**4. Run and reference in other models**

```bash
swamp model method run my-customer create --json
```

```yaml
# Another model referencing the customer
globalArguments:
  customerId: ${{ model.my-customer.resource.customer.primary.attributes.id }}
```

### CEL Paths Used

| Field       | CEL Path                                                         |
| ----------- | ---------------------------------------------------------------- |
| Customer ID | `model.my-customer.resource.customer.primary.attributes.id`      |
| Email       | `model.my-customer.resource.customer.primary.attributes.email`   |
| Created     | `model.my-customer.resource.customer.primary.attributes.created` |

---

## Scenario 2: Cloud Resource CRUD

### User Request

> "I need to create, update, and delete S3 buckets with proper lifecycle
> management."

### What You'll Build

- 1 extension model: `@user/s3-bucket`
- Methods: `create`, `update`, `delete`

### Decision Tree

```
Full lifecycle management → create, update, delete methods
Update reads existing state → Use dataRepository.getContent
Delete cleans up → Return empty dataHandles
```

### Step-by-Step

**1. Create the model file**

```typescript
// extensions/models/s3_bucket.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  bucketName: z.string(),
  region: z.string().default("us-east-1"),
  versioning: z.boolean().default(false),
});

const BucketSchema = z.object({
  Name: z.string(),
  Arn: z.string(),
  Region: z.string(),
  CreationDate: z.string(),
}).passthrough();

export const model = {
  type: "@user/s3-bucket",
  version: "2026.02.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "bucket": {
      description: "S3 bucket resource state",
      schema: BucketSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create an S3 bucket",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { bucketName, region } = context.globalArgs;

        const cmd = new Deno.Command("aws", {
          args: [
            "s3api",
            "create-bucket",
            "--bucket",
            bucketName,
            "--region",
            region,
            ...(region !== "us-east-1"
              ? [
                "--create-bucket-configuration",
                `LocationConstraint=${region}`,
              ]
              : []),
            "--output",
            "json",
          ],
          stdout: "piped",
          stderr: "piped",
        });
        const output = await cmd.output();

        if (!output.success) {
          throw new Error(new TextDecoder().decode(output.stderr));
        }

        const bucketData = {
          Name: bucketName,
          Arn: `arn:aws:s3:::${bucketName}`,
          Region: region,
          CreationDate: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "bucket",
          "main",
          bucketData,
        );
        return { dataHandles: [handle] };
      },
    },
    update: {
      description: "Update bucket settings (enable versioning)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { bucketName, versioning } = context.globalArgs;

        // Read existing data
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "main",
        );

        if (!content) {
          throw new Error("No bucket found - run create first");
        }

        if (versioning) {
          const cmd = new Deno.Command("aws", {
            args: [
              "s3api",
              "put-bucket-versioning",
              "--bucket",
              bucketName,
              "--versioning-configuration",
              "Status=Enabled",
            ],
            stdout: "piped",
            stderr: "piped",
          });
          await cmd.output();
        }

        // Re-read and store updated state
        const existingData = JSON.parse(new TextDecoder().decode(content));
        const updatedData = {
          ...existingData,
          Versioning: versioning ? "Enabled" : "Suspended",
          UpdatedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "bucket",
          "main",
          updatedData,
        );
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Delete the S3 bucket",
      arguments: z.object({}),
      execute: async (_args, context) => {
        // Read stored data to get bucket name
        const content = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          "main",
        );

        if (!content) {
          context.logger.info("No bucket found - nothing to delete");
          return { dataHandles: [] };
        }

        const bucketData = JSON.parse(new TextDecoder().decode(content));

        const cmd = new Deno.Command("aws", {
          args: [
            "s3api",
            "delete-bucket",
            "--bucket",
            bucketData.Name,
          ],
          stdout: "piped",
          stderr: "piped",
        });
        const output = await cmd.output();

        if (!output.success) {
          const error = new TextDecoder().decode(output.stderr);
          // Ignore "bucket not found" errors
          if (!error.includes("NoSuchBucket")) {
            throw new Error(error);
          }
        }

        // Return empty dataHandles - resource is deleted
        return { dataHandles: [] };
      },
    },
  },
};
```

**2. Create workflow for full lifecycle**

```yaml
# workflows/bucket-lifecycle/workflow.yaml
name: bucket-lifecycle
version: 1
inputs:
  properties:
    action:
      type: string
      enum: ["create", "update", "delete"]
  required: ["action"]
jobs:
  - name: execute
    steps:
      - name: create
        condition: ${{ inputs.action == "create" }}
        task:
          type: model_method
          modelIdOrName: my-bucket
          methodName: create

      - name: update
        condition: ${{ inputs.action == "update" }}
        task:
          type: model_method
          modelIdOrName: my-bucket
          methodName: update

      - name: delete
        condition: ${{ inputs.action == "delete" }}
        task:
          type: model_method
          modelIdOrName: my-bucket
          methodName: delete
```

---

## Scenario 3: Factory Model for Discovery

### User Request

> "I need to scan my AWS account and discover all VPCs, then store each one as a
> separately addressable resource."

### What You'll Build

- 1 factory model: `@user/vpc-scanner`
- Produces multiple named instances from a single spec

### Decision Tree

```
Discover multiple resources → Factory model pattern
Each resource needs unique ID → Dynamic instance names
Query all discovered resources → data.findBySpec()
```

### Step-by-Step

**1. Create the factory model**

```typescript
// extensions/models/vpc_scanner.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  region: z.string().default("us-east-1"),
});

const VpcSchema = z.object({
  VpcId: z.string(),
  CidrBlock: z.string(),
  IsDefault: z.boolean(),
  State: z.string(),
}).passthrough();

export const model = {
  type: "@user/vpc-scanner",
  version: "2026.02.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "vpc": {
      description: "Discovered VPC",
      schema: VpcSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    scan: {
      description: "Scan and discover all VPCs in the region",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { region } = context.globalArgs;

        const cmd = new Deno.Command("aws", {
          args: [
            "ec2",
            "describe-vpcs",
            "--region",
            region,
            "--output",
            "json",
          ],
          stdout: "piped",
          stderr: "piped",
        });
        const output = await cmd.output();

        if (!output.success) {
          throw new Error(new TextDecoder().decode(output.stderr));
        }

        const result = JSON.parse(new TextDecoder().decode(output.stdout));
        const vpcs = result.Vpcs || [];

        context.logger.info("Discovered {count} VPCs", { count: vpcs.length });

        const handles = [];
        for (const vpc of vpcs) {
          // Each VPC gets its own instance name based on VpcId
          const handle = await context.writeResource(
            "vpc",
            vpc.VpcId, // Dynamic instance name!
            vpc,
          );
          handles.push(handle);
        }

        return { dataHandles: handles };
      },
    },
  },
};
```

**2. Run the scanner**

```bash
swamp model create @user/vpc-scanner my-scanner --json
swamp model method run my-scanner scan --json
```

**3. Query discovered VPCs**

```yaml
# In another model or workflow
globalArguments:
  # Get all discovered VPCs
  allVpcs: ${{ data.findBySpec("my-scanner", "vpc") }}

  # Access a specific VPC by its ID
  defaultVpc: ${{ model.my-scanner.resource.vpc.vpc-12345678.attributes.CidrBlock }}
```

**4. Iterate over discovered VPCs in workflow**

```yaml
# workflows/tag-all-vpcs/workflow.yaml
name: tag-all-vpcs
version: 1
jobs:
  - name: tag
    steps:
      - name: tag-${{ self.vpc.attributes.VpcId }}
        forEach:
          item: vpc
          in: ${{ data.findBySpec("my-scanner", "vpc") }}
        task:
          type: model_method
          modelIdOrName: vpc-tagger
          methodName: tag
          inputs:
            vpcId: ${{ self.vpc.attributes.VpcId }}
            tags:
              ManagedBy: Swamp
```

### CEL Paths Used

| Query                                                         | Result                                |
| ------------------------------------------------------------- | ------------------------------------- |
| `data.findBySpec("my-scanner", "vpc")`                        | Array of all discovered VPCs          |
| `model.my-scanner.resource.vpc.vpc-12345678.attributes.VpcId` | Specific VPC ID                       |
| `self.vpc.attributes.CidrBlock`                               | Current iteration's CIDR (in forEach) |

---

## Scenario 4: Extending Built-in Models

### User Request

> "I want to add an 'audit' method to the built-in command/shell model that logs
> all executions."

### What You'll Build

- 1 extension file that adds methods to `command/shell`
- No new model type — just new methods on existing type

### Decision Tree

```
Add functionality to existing type → export const extension
Cannot change schema → Only add new methods
```

### Step-by-Step

**1. Create the extension file**

```typescript
// extensions/models/shell_audit.ts
import { z } from "npm:zod@4";

export const extension = {
  type: "command/shell", // Target the built-in type
  methods: [{
    audit: {
      description: "Log execution details for audit purposes",
      arguments: z.object({
        auditTag: z.string().optional(),
      }),
      execute: async (args, context) => {
        const auditEntry = {
          modelName: context.definition.name,
          command: context.globalArgs.run,
          auditTag: args.auditTag || "default",
          timestamp: new Date().toISOString(),
          user: Deno.env.get("USER") || "unknown",
        };

        context.logger.info("Audit: {*}", auditEntry);

        // Write to the shell model's result spec
        const handle = await context.writeResource("result", "result", {
          exitCode: 0,
          command: `audit: ${JSON.stringify(auditEntry)}`,
          executedAt: auditEntry.timestamp,
        });

        return { dataHandles: [handle] };
      },
    },
    dryRun: {
      description: "Show what would be executed without running",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const command = context.globalArgs.run;

        context.logger.info("Would execute: {command}", { command });

        const handle = await context.writeResource("result", "result", {
          exitCode: 0,
          command: `dry-run: ${command}`,
          executedAt: new Date().toISOString(),
        });

        return { dataHandles: [handle] };
      },
    },
  }],
};
```

**2. Verify extension loaded**

```bash
swamp model type describe command/shell --json
# Should show audit and dryRun in methods list
```

**3. Use the new methods**

```bash
# Create a shell model
swamp model create command/shell my-script --json

# Configure it
swamp model edit my-script
# Add: methods.execute.arguments.run = "echo 'Hello'"

# Use the new audit method
swamp model method run my-script audit --json

# Use the new dryRun method
swamp model method run my-script dryRun --json
```

### Extension Rules

| Rule                         | Reason                                     |
| ---------------------------- | ------------------------------------------ |
| Cannot change schema         | Would break existing model instances       |
| Only add new methods         | No overriding existing methods             |
| Use `export const extension` | Distinguishes from new model definitions   |
| Methods array format         | Allows multiple methods per extension file |
