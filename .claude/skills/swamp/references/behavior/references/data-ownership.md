# Data Ownership

Data artifacts are owned by the behavior (definition) that created them. This
prevents accidental overwrites from other behaviors.

## Ownership Rules

- Data can only be written by the behavior that originally created it
- Ownership is verified by comparing `ownerType` and `ownerRef`
- Owner information includes:
  - **type**: `model-method`, `workflow-step`, or `manual`
  - **ref**: Reference to the creating entity
  - **workflow/run IDs**: Set when created during workflow execution

## Ownership Validation

When a method writes data, swamp validates:

1. If data doesn't exist → create with current behavior as owner
2. If data exists → verify the writer's `ownerType` and `ownerRef` match the
   existing item's
3. If owner mismatch → write fails with ownership error

A legacy `definitionHash` may still appear on older data; it is not checked.

This ensures data integrity when multiple behaviors reference the same data
names.
