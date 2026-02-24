# Data Troubleshooting

## Table of Contents

- [Common Errors](#common-errors)
  - ["No such key: resource" in CEL Expressions](#no-such-key-resource-in-cel-expressions)
  - ["No data found for model"](#no-data-found-for-model)
  - ["Data ownership validation failed"](#data-ownership-validation-failed)
  - ["Version not found"](#version-not-found)
  - ["GC deleted data I needed"](#gc-deleted-data-i-needed)
- [Expression Debugging](#expression-debugging)
- [Data Recovery](#data-recovery)
- [Index and Symlink Issues](#index-and-symlink-issues)

## Common Errors

### "No such key: resource" in CEL Expressions

**Symptom**: Expression `model.<name>.resource.<spec>` fails with "No such key:
resource"

**Causes**:

1. **Model never executed** — the `resource` key only exists after a method
   writes data

2. **Wrong spec or instance name** — the path must match exactly what
   `writeResource(specName, instanceName, data)` used

3. **Spec name contains hyphens** — CEL interprets `-` as subtraction

**Solutions**:

```bash
# 1. Verify data exists
swamp data list <model-name> --json

# 2. Check exact spec and instance names
swamp data get <model-name> <data-name> --json

# 3. Run the create method first
swamp model method run <model-name> create --json
```

**CEL path anatomy**:

```
model.my-vpc.resource.vpc.main.attributes.VpcId
      ──────         ─── ───
      model name     |   └── instanceName (from writeResource 2nd arg)
                     └── specName (from writeResource 1st arg)
```

### "No data found for model"

**Symptom**: `swamp data list <model>` returns empty or error

**Causes**:

1. Model exists but no method has been run yet
2. Model was deleted
3. Wrong model name (typo or case mismatch)

**Solutions**:

```bash
# List all models to verify name
swamp model search --json

# Run a method to produce data
swamp model method run <model-name> <method> --json

# Check if model input exists
swamp model get <model-name> --json
```

### "Data ownership validation failed"

**Symptom**:
`Error: Data ownership validation failed - definition hash mismatch`

**Causes**:

1. A different model with the same data name is trying to overwrite data
2. Model definition changed after data was created
3. Manual data manipulation

**Solutions**:

```bash
# View ownership information
swamp data get <model-name> <data-name> --json

# Check the ownerDefinition.definitionHash in output
# Compare with current model's hash

# If intentional: delete the old data first
swamp model delete <old-model-name> --json
```

**Prevention**: Use unique, model-specific data names. Avoid generic names like
"output" or "state" across multiple models.

### "Version not found"

**Symptom**: `data.version("model", "name", N)` returns null or error

**Causes**:

1. Version number never existed
2. GC deleted the version
3. Typo in model or data name

**Solutions**:

```bash
# List all versions
swamp data versions <model-name> <data-name> --json

# Check GC settings
swamp data get <model-name> <data-name> --json
# Look at gcSetting field
```

### "GC deleted data I needed"

**Symptom**: Data that was previously accessible is now gone

**Causes**:

1. Lifetime expired (e.g., `7d`, `ephemeral`)
2. GC setting pruned old versions
3. Manual GC run

**Solutions**:

1. **Prevent future issues** — adjust model's resource spec:

```typescript
resources: {
  "state": {
    schema: StateSchema,
    lifetime: "infinite",    // Never auto-expire
    garbageCollection: 20,   // Keep more versions
  },
},
```

2. **Always preview GC** before running:

```bash
swamp data gc --dry-run --json
```

3. **Restore from backup** if available (`.swamp/data/` directory)

## Expression Debugging

### Step 1: Verify Data Exists

```bash
# Check if model has any data
swamp data list <model-name> --json

# Get specific data item
swamp data get <model-name> <data-name> --json
```

### Step 2: Verify Path Components

For expression `model.my-vpc.resource.vpc.main.attributes.VpcId`:

| Component | Check Command                                           |
| --------- | ------------------------------------------------------- |
| `my-vpc`  | `swamp model get my-vpc --json`                         |
| `vpc`     | `swamp data list my-vpc --json` (check specName in tag) |
| `VpcId`   | `swamp data get my-vpc vpc --json` (check attributes)   |

### Step 3: Validate Model Definition

```bash
swamp model validate <model-name> --json
```

Look for expression validation errors in the output.

### Step 4: Test Expression in Isolation

Create a test model that uses the expression and run validate:

```yaml
name: test-expression
globalArguments:
  testValue: ${{ model.my-vpc.resource.vpc.main.attributes.VpcId }}
```

```bash
swamp model validate test-expression --json
```

## Data Recovery

### From Version History

If data was overwritten but older versions exist:

```bash
# List versions
swamp data versions <model-name> <data-name> --json

# Access specific version in CEL
oldValue: ${{ data.version("model-name", "data-name", 1).attributes.field }}
```

### From Workflow Run

If data was produced by a workflow:

```bash
# Find the workflow run
swamp workflow history search --json

# List data from that run
swamp data list --workflow <workflow-name> --run <run-id> --json
```

### From File System

Data is stored in `.swamp/data/`. Structure:

```
.swamp/data/{normalized-type}/{model-id}/{data-name}/
  1/raw           # Version 1 content
  1/metadata.yaml # Version 1 metadata
  2/raw           # Version 2 content
  2/metadata.yaml # Version 2 metadata
  latest → 2/     # Symlink to latest
```

## Index and Symlink Issues

### Broken Symlinks in models/ Directory

**Symptom**: `ls models/<name>/resource.yaml` shows broken symlink

**Solution**:

```bash
# Verify and rebuild index
swamp repo index --verify --json

# Prune broken symlinks
swamp repo index --prune --json

# Full rebuild
swamp repo index --json
```

### Data Not Appearing After Method Run

**Symptom**: Method succeeded but `swamp data list` doesn't show new data

**Solutions**:

1. **Check method output** — verify dataHandles were returned:

```bash
swamp model output get <model-name> --json
# Look for artifacts in output
```

2. **Rebuild index**:

```bash
swamp repo index --json
```

3. **Check data directory directly**:

```bash
ls -la .swamp/data/<type>/<model-id>/
```

### Stale Search Results

**Symptom**: `swamp data search` returns outdated results

**Solution**: Rebuild the search index:

```bash
swamp repo index --json
```
