# Model Troubleshooting

## Table of Contents

- [Common Errors](#common-errors)
  - ["Model not found"](#model-not-found)
  - ["Method not found"](#method-not-found)
  - ["Validation failed"](#validation-failed)
  - ["Expression evaluation failed"](#expression-evaluation-failed)
  - ["No such key" in CEL expressions](#no-such-key-in-cel-expressions)
  - ["Model type not found"](#model-type-not-found)
- [Expression Debugging](#expression-debugging)
- [Method Execution Issues](#method-execution-issues)
- [Data and Output Issues](#data-and-output-issues)

## Common Errors

### "Model not found"

**Symptom**: `Error: Model 'my-model' not found`

**Causes and solutions**:

1. **Typo in model name** — list available models:

   ```bash
   swamp model search --json
   ```

2. **Model not created** — create it:

   ```bash
   swamp model create <type> my-model --json
   ```

3. **Using ID instead of name** — both work, but verify:

   ```bash
   swamp model get my-model --json
   # Check both id and name fields
   ```

### "Method not found"

**Symptom**: `Error: Method 'deploy' not found on model type`

**Causes and solutions**:

1. **Wrong method name** — check available methods:

   ```bash
   swamp model type describe <type> --json
   # Look at methods array
   ```

2. **Method not configured in input** — add to model input:

   ```yaml
   methods:
     deploy:
       arguments: {}
   ```

### "Validation failed"

**Symptom**: `swamp model validate` returns errors

**Common validation errors**:

| Error                      | Solution                              |
| -------------------------- | ------------------------------------- |
| Missing required field     | Add the field to model input          |
| Invalid type for field     | Check schema, fix value type          |
| Unknown property           | Remove field or check for typo        |
| Invalid expression syntax  | Fix CEL expression syntax             |
| Referenced model not found | Create the model or fix the reference |

**Debug steps**:

```bash
# 1. Get the type schema
swamp model type describe <type> --json

# 2. Compare with your input
swamp model get my-model --json

# 3. Validate with verbose output
swamp model validate my-model --json
```

### "Expression evaluation failed"

**Symptom**: `Error evaluating expression: <expression>`

**Common causes**:

1. **Referenced model has no data**:

   ```bash
   # Check if the model has run
   swamp data list <referenced-model> --json
   ```

2. **Wrong attribute path**:

   ```bash
   # Get the actual data structure
   swamp data get <model> <data-name> --json
   # Check the attributes object
   ```

3. **Syntax error in expression**:

   ```yaml
   # Wrong — missing instance name
   value: ${{ model.my-vpc.resource.vpc.attributes.VpcId }}

   # Correct — spec="vpc", instance="main"
   value: ${{ model.my-vpc.resource.vpc.main.attributes.VpcId }}
   ```

### "No such key" in CEL expressions

**Symptom**: `Error: No such key: <keyname>`

**Causes**:

1. **Missing instance name in path**:

   ```yaml
   # Wrong — missing instance name
   vpcId: ${{ model.my-vpc.resource.vpc.attributes.VpcId }}

   # Correct — include instance name (spec="vpc", instance="main")
   vpcId: ${{ model.my-vpc.resource.vpc.main.attributes.VpcId }}
   ```

2. **Model never executed**:

   ```bash
   swamp model method run my-vpc create --json
   ```

3. **Hyphen in spec name** (CEL interprets as subtraction):

   ```yaml
   # Wrong — spec name with hyphen
   resource.internet-gateway.internet-gateway  # Parsed as subtraction

   # Correct — use camelCase or no hyphen
   resource.igw.igw
   ```

4. **Wrong attribute name**:

   ```bash
   # Check actual attribute names
   swamp data get my-vpc vpc --json
   ```

### "Model type not found"

**Symptom**: `Error: Model type '<type>' not found`

**Causes and solutions**:

1. **Typo in type name**:

   ```bash
   swamp model type search --json
   ```

2. **Extension model not loaded** — check for syntax errors:

   ```bash
   # Look for error messages at startup
   swamp model type search 2>&1 | grep -i error
   ```

3. **Extension in wrong directory**:

   ```
   extensions/models/my_model.ts  # Correct
   extensions/my_model.ts         # Wrong
   models/my_model.ts             # Wrong
   ```

## Expression Debugging

### Step-by-Step Debug Process

**Step 1: Validate the expression references a real model**

```bash
swamp model get <referenced-model> --json
```

**Step 2: Verify the model has data**

```bash
swamp data list <referenced-model> --json
```

**Step 3: Check the exact data structure**

```bash
swamp data get <referenced-model> <data-name> --json
```

**Step 4: Build the expression path**

```
model.<model-name>.resource.<specName>.<instanceName>.attributes.<field>

Example:
model.my-vpc.resource.vpc.main.attributes.VpcId
      └─────┘         └─┘ └──┘            └───┘
      model name      |    |              attribute
                      |    └── instanceName (from writeResource 2nd arg)
                      └── specName (from writeResource 1st arg)
```

### Common Expression Patterns

| Model Type    | Spec     | Instance | Expression Pattern                                           |
| ------------- | -------- | -------- | ------------------------------------------------------------ |
| command/shell | result   | result   | `model.<name>.resource.result.result.attributes.stdout`      |
| Custom model  | (varies) | (varies) | `model.<name>.resource.<spec>.<instance>.attributes.<field>` |

## Method Execution Issues

### Method Runs But No Output

**Symptom**: Method succeeds but no data artifacts

**Causes**:

1. **Model doesn't call writeResource**:

   ```typescript
   // Must return dataHandles
   return { dataHandles: [handle] };
   ```

2. **Method threw after writing** — check logs:

   ```bash
   swamp model output logs <output-id> --json
   ```

### Method Fails with Timeout

**Symptom**: Method times out

**Solutions**:

1. **Increase timeout for long-running operations**

2. **Check for infinite loops in custom models**

3. **Verify network connectivity for API calls**

### Method Fails with Authentication Error

**Symptom**: AWS/API authentication errors

**Solutions**:

```bash
# Check environment variables
echo $AWS_ACCESS_KEY_ID
echo $AWS_REGION

# Verify credentials work
aws sts get-caller-identity

# Check vault expressions resolve
swamp vault get <vault-name> <key> --json
```

## Data and Output Issues

### Output Shows "succeeded" But Data Missing

**Debug steps**:

```bash
# 1. Get output details
swamp model output get <model-name> --json

# 2. Check artifacts array
# Look for "artifacts" in output

# 3. List model data
swamp data list <model-name> --json

# 4. Rebuild index if needed
swamp repo index --json
```

### Cannot Find Previous Output

```bash
# Search all outputs
swamp model output search --json

# Search by model name
swamp model output search "my-model" --json

# Get specific output
swamp model output get <output-id> --json
```

### Data Versions Not Visible

```bash
# List all versions
swamp data versions <model-name> <data-name> --json

# Check GC settings haven't pruned them
swamp data get <model-name> <data-name> --json
# Look at gcSetting field
```
