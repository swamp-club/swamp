# Data Ownership

Data artifacts are owned by the model (definition) that created them. This
ensures data integrity and prevents accidental overwrites.

## Owner Definition

Each data item tracks its owner through the `ownerDefinition` field:

| Field            | Description                                    |
| ---------------- | ---------------------------------------------- |
| `ownerType`      | `model-method`, `workflow-step`, or `manual`   |
| `ownerRef`       | Reference to the creating entity               |
| `definitionHash` | Legacy; kept on older data, never checked      |
| `workflowId`     | Set when created during workflow execution     |
| `workflowRunId`  | Specific run that created this data            |
| `workflowName`   | Name of the workflow (empty outside workflows) |
| `jobName`        | Name of the job (empty outside workflows)      |
| `stepName`       | Name of the step (empty outside workflows)     |
| `source`         | Provenance source (e.g. `"step-output"`, `""`) |

These provenance fields are also promoted to first-class `DataRecord` fields
(`ownerRef`, `workflowRunId`, `workflowName`, `jobName`, `stepName`, `source`)
and are directly queryable in CEL predicates:

```cel
workflowRunId == "run-uuid" && stepName == "dedup"
```

## Ownership Validation

When a model method writes data:

1. **New data**: Created with current model as owner
2. **Existing data**: The writer's `ownerType` and `ownerRef` must match the
   existing item's
3. **Owner mismatch**: Write fails with an ownership error

This prevents scenarios where multiple models accidentally share data names.
`definitionHash` plays no part: it survives only on data written by older
versions and is not compared.

## Viewing Ownership

Use `swamp data query` to see the owner type and ref, the two fields ownership
is checked on:

```bash
swamp data query 'modelName == "my-model" && name == "state"' --select '{"ownerType": ownerType, "ownerRef": ownerRef}'
```
