# Pre-flight Checks Reference

Pre-flight checks run automatically before every method except read and list
methods. They validate conditions before execution — avoiding half-completed
operations.

A method's kind is its declared `kind` when set, otherwise inferred from its
name (case-insensitive, so `Get` and `LIST` count too):

- `get`, `read`, `describe`, `show` → read: no checks.
- `list`, `search`, `find` → list: no checks.
- Any other name (`create`, `update`, `delete`, `sync`, `resolve`, `deploy`, …)
  → checks run.

Set `kind: "read"` or `kind: "list"` on a method to skip checks for a read-only
method with another name; a declared `kind` overrides the name.

Exception: a workflow step placed on a worker skips pre-flight checks entirely —
neither the orchestrator nor the worker runs them.

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
      // NOTE: writeResource, deleteResource, and createFileWriter are NOT
      //       available in checks
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
- `dependency` — cross-behavior dependency validation

## appliesTo Scoping

If `appliesTo` is omitted, the check runs before every method that runs checks
(see the top of this page). To scope a check to specific methods, list their
names — any method name works, not just `create`/`update`/`delete`:

```typescript
appliesTo: ["create"],           // only on create
appliesTo: ["create", "update"], // on create and update, not delete
appliesTo: ["resolve"],          // a custom method name
```

Naming a read or list method in `appliesTo` has no effect: checks never run
before those.

## Skipping Checks

```bash
swamp behavior run my-behavior create --skip-checks              # skip all
swamp behavior run my-behavior create --skip-check valid-region  # skip by name
swamp behavior run my-behavior create --skip-check-label live    # skip by label
```

## Extension Checks

Extensions can add checks to existing behavior types. The `checks` field is an
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

A check whose name the base behavior already defines is not registered (the base
check wins) and a `swamp-warning` names the file. When two extensions add the
same check name, a local extension beats a pulled one, then the smaller file
path wins — the same rule as methods (see `api.md`, "Name collisions").
