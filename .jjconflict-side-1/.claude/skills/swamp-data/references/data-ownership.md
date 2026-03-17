# Data Ownership

Data artifacts are owned by the model (definition) that created them. This
ensures data integrity and prevents accidental overwrites.

## Owner Definition

Each data item tracks its owner through the `ownerDefinition` field:

| Field            | Description                                  |
| ---------------- | -------------------------------------------- |
| `ownerType`      | `model-method`, `workflow-step`, or `manual` |
| `ownerRef`       | Reference to the creating entity             |
| `definitionHash` | Hash of the definition at creation time      |
| `workflowId`     | Set when created during workflow execution   |
| `workflowRunId`  | Specific run that created this data          |

## Ownership Validation

When a model method writes data:

1. **New data**: Created with current model as owner
2. **Existing data**: Validates `ownerDefinition.definitionHash` matches
3. **Hash mismatch**: Write fails with ownership error

This prevents scenarios where multiple models accidentally share data names.

## Viewing Ownership

Use `swamp data get` to see ownership information:

```bash
swamp data get my-model state --json
```

```json
{
  "name": "state",
  "version": 3,
  "ownerDefinition": {
    "ownerType": "model-method",
    "ownerRef": "my-model:create",
    "definitionHash": "abc123..."
  }
}
```
