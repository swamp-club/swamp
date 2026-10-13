# Three-Level Report Control Model

Reports are controlled at three levels, from most general to most specific.

## 1. Behavior Type Defaults (TypeScript `ModelDefinition`)

The `reports` field on the behavior type (`ModelDefinition`) lists standalone
report names that are defaults for any behavior of this type:

```typescript
// extensions/behaviors/ec2.ts
export const behavior = {
  type: "@myorg/ec2",
  version: "2026.03.01.1",
  reports: ["@myorg/cost-report", "@myorg/drift-report"],
  // ... methods, resources, etc.
};
```

## 2. Definition YAML Overrides (`reportSelection`)

The `reports:` field in definition YAML provides per-definition overrides.
`require` adds reports beyond behavior-type defaults. `skip` removes reports
from the defaults.

```yaml
# definitions/my-vpc.yaml
id: 550e8400-e29b-41d4-a716-446655440000
name: my-vpc
version: 1
tags: {}
reports:
  require:
    - "@myorg/compliance-report" # adds to behavior-type defaults
    - name: security-audit # only run for these methods
      methods: ["create", "delete"]
  skip:
    - "@myorg/drift-report" # removes from behavior-type defaults
globalArguments:
  cidrBlock: "10.0.0.0/16"
methods:
  create:
    arguments: {}
```

## 3. Workflow YAML Overrides

The `reports:` field in workflow YAML controls workflow-scope reports and can
also override behavior-level reports for the workflow run.

```yaml
# workflows/deploy.yaml
name: deploy
reports:
  require:
    - "@myorg/workflow-summary" # workflow-scope report
  skip:
    - "@myorg/cost-report" # skip for all behaviors in this workflow
```

## Filtering Semantics and Precedence

The candidate set is built from behavior-type defaults plus `require`, minus
`skip`, with CLI flags applied last. `skip` always wins over `require`, and
`require` makes a report immune to CLI skip flags. See
[filtering.md](filtering.md) for the full set composition and precedence rules.
