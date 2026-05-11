# Pre-flight Checks Reference

Pre-flight checks run automatically before any mutating method (`create`,
`update`, `delete`, `action`). They validate conditions before execution —
avoiding half-completed operations.

## CheckDefinition Interface

```typescript
checks: {
  "check-name": {
    description: "Human-readable description of what is validated",
    labels: ["policy", "live"],          // optional categorization tags
    appliesTo: ["create", "update"],     // optional: limit to specific methods
    execute: async (context) => {
      // context has: globalArgs, definition, methodName, repoDir, logger,
      //              dataRepository, modelType, modelId
      // NOTE: writeResource and createFileWriter are NOT available in checks
      return { pass: true };
      // or: return { pass: false, errors: ["Reason check failed"] };
    },
  },
},
```

## CheckResult

```typescript
interface CheckResult {
  pass: boolean;
  errors?: string[]; // human-readable failure reasons when pass is false
}
```

## Example: Value/Policy Validation

```typescript
checks: {
  "valid-region": {
    description: "Ensure the target region is an allowed region",
    labels: ["policy"],
    execute: async (context) => {
      const allowed = ["us-east-1", "us-west-2", "eu-west-1"];
      const region = context.globalArgs.region;
      if (!allowed.includes(region)) {
        return {
          pass: false,
          errors: [`Region "${region}" is not in the allowed list: ${allowed.join(", ")}`],
        };
      }
      return { pass: true };
    },
  },
},
```

## Labels Convention

Use labels to categorize checks for selective skipping:

- `policy` — business rules and constraints
- `live` — checks that make live API calls
- `dependency` — cross-model dependency validation

## appliesTo Scoping

If `appliesTo` is omitted, the check runs before all mutating methods. To scope
a check to specific methods:

```typescript
appliesTo: ["create"],           // only on create
appliesTo: ["create", "update"], // on create and update, not delete
```

## Skipping Checks

```bash
swamp model method run my-model create --skip-checks              # skip all
swamp model method run my-model create --skip-check valid-region  # skip by name
swamp model method run my-model create --skip-check-label live    # skip by label
```

## Extension Checks

Extensions can add checks to existing model types. The `checks` field is an
array of `Record<string, CheckDefinition>` objects, following the same
array-of-records pattern as `methods`:

```typescript
export const extension = {
  type: "aws/ec2/vpc",
  methods: [],
  checks: [{
    "no-cidr-overlap": {
      description: "Ensure CIDR does not overlap with existing VPCs",
      labels: ["policy"],
      execute: async (context) => {
        // validation logic
        return { pass: true };
      },
    },
  }],
};
```

Check names must not conflict with checks already defined on the target model
type — conflicts throw an error at registration time.
