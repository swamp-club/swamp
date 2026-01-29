# AWS Models

This directory contains AWS model implementations that use the AWS CloudControl
API for resource management.

## Adding a New AWS Model

To add a new AWS model, extend the `AWSCloudControlModel` base class. This
provides common implementations for `create`, `delete`, and `sync` operations.

### Step 1: Create the Directory Structure

```
src/domain/models/aws/<service>/<resource>/
  ├── <resource>_model.ts
  └── <resource>_model_test.ts
```

For example, for an S3 Bucket:

```
src/domain/models/aws/s3/bucket/
  ├── s3_bucket_model.ts
  └── s3_bucket_model_test.ts
```

### Step 2: Define Input and Resource Schemas

Create Zod schemas for input attributes (what users provide) and resource
attributes (what AWS returns):

```typescript
import { z } from "zod";

// Input schema - matches CloudControl API properties
export const S3BucketInputAttributesSchema = z.object({
  BucketName: z.string().optional(),
  Tags: z.array(z.object({
    Key: z.string(),
    Value: z.string(),
  })).optional(),
  // ... other properties from CloudFormation spec
});

// Resource schema - what gets returned from AWS
export const S3BucketResourceAttributesSchema = z.object({
  BucketName: z.string(),
  Arn: z.string().optional(),
  DomainName: z.string().optional(),
  RegionalDomainName: z.string().optional(),
  // ... other read-only properties
});
```

### Step 3: Create the Model Type

```typescript
import { ModelType } from "../../../model_type.ts";

export const S3_BUCKET_MODEL_TYPE = ModelType.create("AWS::S3::Bucket");
```

### Step 4: Extend AWSCloudControlModel

```typescript
import { AWSCloudControlModel } from "../../cloud_control_model.ts";

class S3BucketModel extends AWSCloudControlModel<
  typeof S3BucketInputAttributesSchema,
  typeof S3BucketResourceAttributesSchema
> {
  constructor() {
    super({
      // The CloudFormation type name (used in CloudControl API calls)
      typeName: "AWS::S3::Bucket",

      // The model type for this model
      modelType: S3_BUCKET_MODEL_TYPE,

      // Schemas for validation
      inputAttributesSchema: S3BucketInputAttributesSchema,
      resourceAttributesSchema: S3BucketResourceAttributesSchema,

      // Extract the AWS resource identifier from stored attributes
      // This is used when deleting resources
      extractResourceIdentifier: (attributes) => {
        return (attributes.BucketName as string | undefined) ||
          (attributes.ResourceIdentifier as string | undefined);
      },

      // Map raw AWS properties to your resource attributes
      // This is called after sync completes successfully
      mapResourceProperties: (rawProperties) => ({
        BucketName: rawProperties.BucketName,
        Arn: rawProperties.Arn,
        DomainName: rawProperties.DomainName,
        RegionalDomainName: rawProperties.RegionalDomainName,
        Tags: rawProperties.Tags,
      }),
    });
  }
}
```

### Step 5: Export the Model Definition

```typescript
const s3BucketModelInstance = new S3BucketModel();

export const s3BucketModel = s3BucketModelInstance.createModelDefinition();
```

### Step 6: Register the Model

Add the model to the global registry in `src/domain/models/model_lookup.ts`:

```typescript
import { s3BucketModel } from "./aws/s3/bucket/s3_bucket_model.ts";

modelRegistry.register(s3BucketModel);
```

## Configuration Options

The `CloudControlModelConfig` interface accepts:

| Option                      | Required | Description                                               |
| --------------------------- | -------- | --------------------------------------------------------- |
| `typeName`                  | Yes      | AWS CloudFormation type name (e.g., `AWS::S3::Bucket`)    |
| `modelType`                 | Yes      | The `ModelType` instance for this model                   |
| `inputAttributesSchema`     | Yes      | Zod schema for input validation                           |
| `resourceAttributesSchema`  | Yes      | Zod schema for resource validation                        |
| `extractResourceIdentifier` | No       | Function to extract AWS resource ID from attributes       |
| `mapResourceProperties`     | No       | Function to map raw AWS properties to resource attributes |

## What the Base Class Provides

The `AWSCloudControlModel` base class handles:

- **create**: Calls CloudControl `CreateResource`, returns a `RequestToken` for
  tracking, and schedules a `sync` follow-up action
- **delete**: Calls CloudControl `DeleteResource`, handles "not found" errors
  gracefully, and schedules a `sync` follow-up action
- **sync**: Polls `GetResourceRequestStatus` until the operation completes, then
  calls `GetResource` to fetch full resource details

All methods handle:

- Async operation tracking via `RequestToken`
- Automatic polling with configurable delays
- Resource-not-found error handling
- Deletion context tracking

## Finding CloudFormation Type Names

To find the correct `typeName` for an AWS resource:

1. Check the
   [AWS CloudFormation Resource Types Reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-template-resource-type-ref.html)
2. Use the format `AWS::<Service>::<Resource>` (e.g., `AWS::EC2::Instance`,
   `AWS::S3::Bucket`)

## Testing

See `ec2/instance/ec2_instance_model_test.ts` for examples of how to test AWS
models using mock CloudControl clients.
