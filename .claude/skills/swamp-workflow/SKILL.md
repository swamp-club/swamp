---
name: swamp-workflow
description: Work with swamp workflows for AI-native automation. Use when searching for workflows, creating new workflows, validating workflow definitions, or running workflows. Triggers on requests involving "swamp workflow", "workflow", "run workflow", or "create workflow".
---

# Swamp Workflow Skill

Work with swamp workflows through the CLI. All commands support `--json` for
machine-readable output.

## Repository Structure

Swamp uses a dual-layer architecture:

- **Data directory (`/.data/`)** - Internal storage organized by entity type
- **Logical views (`/workflows/`)** - Human-friendly symlinked directories

The `/workflows/` directory provides convenient exploration of each workflow:

```
/workflows/{workflow-name}/
  workflow.yaml → ../.data/workflows/{id}.yaml
  runs/
    latest → {most-recent-run}/
    {timestamp}/
      run.yaml → ../.data/workflow-runs/{id}/{run-id}.yaml
```

This structure is maintained automatically. Use `swamp repo index` to rebuild if
needed.

## Quick Reference

| Task              | Command                                       |
| ----------------- | --------------------------------------------- |
| Get schema        | `swamp workflow schema get --json`            |
| Search workflows  | `swamp workflow search [query] --json`        |
| Get a workflow    | `swamp workflow get <id_or_name> --json`      |
| Create a workflow | `swamp workflow create <name> --json`         |
| Validate workflow | `swamp workflow validate [id_or_name] --json` |
| Run a workflow    | `swamp workflow run <id_or_name> --json`      |

## IMPORTANT: Always Get Schema First

Before creating or editing a workflow file, ALWAYS get the schema first:

```bash
swamp workflow schema get --json
```

This ensures you understand the exact structure and constraints for valid
workflow files.

## Get Workflow Schema

Get the complete JSON Schema for workflow files.

```bash
swamp workflow schema get --json
```

**Output shape:**

```json
{
  "workflow": {/* JSON Schema for top-level workflow */},
  "job": {/* JSON Schema for job objects */},
  "jobDependency": {/* JSON Schema for job dependency with condition */},
  "step": {/* JSON Schema for step objects */},
  "stepDependency": {/* JSON Schema for step dependency with condition */},
  "stepTask": {/* JSON Schema for task (shell or model_method) */},
  "triggerCondition": {/* JSON Schema for dependency conditions */}
}
```

**Key schemas:**

- `workflow` - Top-level structure with id, name, description, jobs, version
- `job` - Job definition with name, steps, dependsOn, weight
- `jobDependency` - Job dependency with target job name and trigger condition
- `step` - Step definition with name, task, dependsOn, weight
- `stepDependency` - Step dependency with target step name and trigger condition
- `stepTask` - Discriminated union: `type: "shell"` or `type: "model_method"`
- `triggerCondition` - Conditions like `always`, `succeeded(ref)`,
  `failed(ref)`, etc.

## Search for Workflows

Find existing workflows in the repository.

```bash
swamp workflow search --json
swamp workflow search "deploy" --json
```

**Output shape:**

```json
{
  "query": "",
  "results": [
    { "id": "abc-123", "name": "my-workflow", "jobCount": 2 }
  ]
}
```

Select the workflow whose `name` best matches the user's intent.

## Get a Workflow

Get full details of a specific workflow including jobs and steps.

```bash
swamp workflow get my-workflow --json
```

**Output shape:**

```json
{
  "id": "abc-123",
  "name": "my-workflow",
  "version": 1,
  "jobs": [
    {
      "name": "main",
      "description": "Main job",
      "steps": [
        {
          "name": "example",
          "description": "Example step",
          "task": {
            "type": "shell",
            "command": "echo",
            "args": ["Hello!"]
          }
        }
      ]
    }
  ],
  "path": "workflows/workflow-abc-123.yaml"
}
```

**Key fields:**

- `jobs` - Array of jobs that run in the workflow
- `steps` - Steps within each job (run sequentially by default)
- `path` - File path to read/edit the workflow definition

## Create a Workflow

Create a new workflow file.

```bash
swamp workflow create my-deploy-workflow --json
```

**Output shape:**

```json
{
  "id": "abc-123",
  "name": "my-deploy-workflow",
  "path": "workflows/workflow-abc-123.yaml"
}
```

After creation, edit the YAML file at the returned `path` to add jobs and steps.

**Example workflow file structure:**

```yaml
# .data/workflows/workflow-abc-123.yaml
id: abc-123
name: my-deploy-workflow
description: Deploy workflow with build and deploy jobs
version: 1
jobs:
  - name: build
    description: Build the application
    steps:
      - name: compile
        description: Compile source code
        task:
          type: shell
          command: deno
          args: ["task", "build"]
  - name: deploy
    description: Deploy the application
    dependsOn:
      - job: build
        condition:
          type: succeeded
          ref: build
    steps:
      - name: upload
        description: Upload artifacts
        task:
          type: shell
          command: ./deploy.sh
```

## Validate Workflows

Validate a specific workflow or all workflows against their schemas.

**Validate a single workflow:**

```bash
swamp workflow validate my-workflow --json
```

**Output shape (single):**

```json
{
  "workflowId": "abc-123",
  "workflowName": "my-workflow",
  "validations": [
    { "name": "Schema validation", "passed": true },
    { "name": "Unique job names", "passed": true },
    { "name": "Valid job dependency references", "passed": true },
    { "name": "No cyclic job dependencies", "passed": true }
  ],
  "passed": true
}
```

**Validate all workflows:**

```bash
swamp workflow validate --json
```

**Output shape (all):**

```json
{
  "workflows": [
    { "workflowId": "abc-123", "workflowName": "my-workflow", "validations": [...], "passed": true }
  ],
  "totalPassed": 1,
  "totalFailed": 0,
  "passed": true
}
```

Always validate after editing a workflow file to catch errors early.

## Run a Workflow

Execute a workflow and get execution results.

```bash
swamp workflow run my-workflow --json
```

**Output shape:**

```json
{
  "id": "run-456",
  "workflowId": "abc-123",
  "workflowName": "my-workflow",
  "status": "succeeded",
  "jobs": [
    {
      "name": "main",
      "status": "succeeded",
      "steps": [
        { "name": "example", "status": "succeeded", "duration": 2 }
      ],
      "duration": 2
    }
  ],
  "duration": 5,
  "path": "workflows/workflow-abc-123/workflow-run-456-timestamp.yaml"
}
```

**Key fields:**

- `status` - Overall workflow status: `succeeded`, `failed`, or `running`
- `jobs[].status` - Individual job status
- `jobs[].steps[].status` - Individual step status
- `duration` - Execution time in milliseconds
- `path` - Path to the workflow run log file

After running, summarize results to the user including which jobs/steps
succeeded or failed and their durations.

## Expressions in Workflows

Model inputs can contain CEL expressions using the `${{ <expression> }}` syntax.
When expressions reference `model.<name>.resource.attributes.*`, they create
**implicit step dependencies**.

### Automatic Dependency Resolution

Workflow execution automatically:

1. Detects resource dependencies in expressions
2. Ensures dependent steps run after the step that creates the resource
3. Evaluates expressions just-in-time before each step executes

### Example with Implicit Dependencies

```yaml
# vpc-input has no expressions
# subnet-input has: vpcId: ${{ model.vpc-input.resource.attributes.vpcId }}

jobs:
  - name: main
    steps:
      - name: create-subnet # Listed first but runs second!
        task:
          type: model_method
          modelIdOrName: subnet-input
          methodName: create
      - name: create-vpc
        task:
          type: model_method
          modelIdOrName: vpc-input
          methodName: create
# create-vpc runs first due to implicit dependency from expression
```

In this example, `subnet-input` references
`vpc-input.resource.attributes.vpcId`. The workflow engine detects this and
ensures `create-vpc` runs before `create-subnet`, regardless of their declared
order.

## Working with Vaults in Workflows

Swamp provides a comprehensive vault system for secure secret management in
workflows. Vaults allow you to store and retrieve sensitive data like API keys,
passwords, and tokens without exposing them in workflow files.

### Vault Configuration

Vaults are created using the CLI, **not** configured in `.swamp.yaml`. The
`.swamp.yaml` file only stores repository metadata.

```bash
# Create a local encryption vault (for development)
swamp vault create local_encryption dev-secrets

# Create an AWS Secrets Manager vault (for production)
swamp vault create aws prod-secrets

# Store secrets in a vault
swamp vault put dev-secrets api-key=sk-1234567890abcdef

# List available vaults
swamp vault search

# List keys in a vault
swamp vault list-keys dev-secrets
```

Vaults are stored in `.data/vault/{vault-type}/{name}.yaml` and loaded
automatically when workflows execute.

### Vault Expression Syntax

Access secrets in workflows using vault expressions:

```yaml
# Basic secret retrieval
apiKey: ${{ vault.get(dev-secrets, api-key) }}

# Environment-specific secrets
prodToken: ${{ vault.get(prod-secrets, auth-token) }}
devToken: ${{ vault.get(dev-secrets, auth-token) }}

# AWS Secrets Manager
dbPassword: ${{ vault.get(aws-vault, database/password) }}
```

### Managing Secrets with CLI Commands

Use the swamp CLI to manage secrets:

```bash
# Store a secret in a vault
swamp vault put dev-secrets api-key=sk-1234567890abcdef

# Retrieve a secret from a vault
swamp vault get dev-secrets api-key

# List all secret keys in a vault
swamp vault list-keys dev-secrets
```

### Using the Vault Model (swamp/lets-get-sensitive)

For advanced vault operations within workflows, use the dedicated vault model:

```yaml
# Store a generated secret
- name: store-api-key
  task:
    type: model_method
    modelIdOrName: store-api-secret
    methodName: store-secret

# Where store-api-secret model has:
# type: swamp/lets-get-sensitive
# attributes:
#   vaultName: prod-secrets
#   secretKey: generated-api-key
#   secretValue: ${{ model.api-generator.data.attributes.apiKey }}
#   operation: put
```

```yaml
# Retrieve a stored secret
- name: get-db-credentials
  task:
    type: model_method
    modelIdOrName: get-db-secret
    methodName: get-secret

# Where get-db-secret model has:
# type: swamp/lets-get-sensitive
# attributes:
#   vaultName: aws-vault
#   secretKey: database/credentials
#   operation: get
```

### Vault Security Best Practices

1. **Environment Separation**: Use different vaults for dev/staging/prod
   environments
2. **Least Privilege**: Configure vault access with minimal required permissions
3. **Key Rotation**: Regularly rotate secrets and vault encryption keys
4. **No Hardcoding**: Never put secrets directly in workflow files
5. **Audit Logging**: Monitor vault access through provider audit logs

### Example: Complete Vault Workflow

```yaml
id: vault-demo-workflow
name: vault-demo
description: Demonstrate vault usage for secure secret management
version: 1
jobs:
  - name: setup
    description: Setup environment with vault secrets
    steps:
      - name: configure-api
        description: Configure API with vault-stored credentials
        task:
          type: shell
          command: bash
          args:
            - -c
            - |
                echo "Configuring API with vault credentials..."
                # API key comes from vault expression
                export API_KEY="${{ vault.get(prod-secrets, api-key) }}"
                export DB_PASSWORD="${{ vault.get(aws-vault, database/password) }}"

                # Use credentials to configure application
                ./configure-app.sh

  - name: deploy
    description: Deploy application with vault-managed secrets
    dependsOn:
      - job: setup
        condition:
          type: succeeded
          ref: setup
    steps:
      - name: deploy-service
        description: Deploy with environment-specific secrets
        task:
          type: model_method
          modelIdOrName: deployment-config
          methodName: deploy
        # Where deployment-config model attributes include:
        # serviceToken: ${{ vault.get(prod-secrets, service-token) }}
        # webhookSecret: ${{ vault.get(prod-secrets, webhook-secret) }}

  - name: post-deploy
    description: Store generated deployment artifacts
    dependsOn:
      - job: deploy
        condition:
          type: succeeded
          ref: deploy
    steps:
      - name: store-deployment-id
        description: Store deployment ID for future reference
        task:
          type: model_method
          modelIdOrName: store-deployment-info
          methodName: store-secret
        # Where store-deployment-info model has:
        # type: swamp/lets-get-sensitive
        # attributes:
        #   vaultName: prod-secrets
        #   secretKey: latest-deployment-id
        #   secretValue: ${{ model.deployment-config.data.attributes.deploymentId }}
        #   operation: put
```

### Vault Types and Configuration

#### Vault Requirements

Any vault referenced in a workflow file must be created via the CLI before the
workflow runs. Create vaults using `swamp vault create <type> <name>`.

#### Local Encryption Vault

Stores secrets encrypted locally using AES-256-GCM:

```bash
# Create a local encryption vault
swamp vault create local_encryption my-vault

# The vault is stored in .data/vault/local_encryption/my-vault.yaml
# Encryption keys are auto-generated and stored securely
```

#### AWS Secrets Manager Vault

Integrates with AWS Secrets Manager:

```bash
# Create an AWS Secrets Manager vault
swamp vault create aws my-aws-vault
```

Note: AWS credentials are obtained from the default AWS credential chain
(environment variables, shared credentials file, IAM role, etc.).

#### Customizing Vault Configuration

Vaults are created with default configuration. To customize settings (e.g., AWS
region), edit the vault config file directly:

```bash
# Edit a vault's configuration
swamp vault edit my-aws-vault

# Or edit the file directly at:
# .data/vault/{type}/{name}.yaml
```

Example AWS vault config:

```yaml
id: abc-123
name: my-aws-vault
type: aws
config:
  region: us-west-2 # Change from default us-east-1
```

Example local encryption vault config:

```yaml
id: def-456
name: my-vault
type: local_encryption
config:
  auto_generate: true
  base_dir: .
```

### Vault Operations Reference

| Operation    | Expression Syntax                   | CLI Command                              | Description             |
| ------------ | ----------------------------------- | ---------------------------------------- | ----------------------- |
| Create vault | N/A                                 | `swamp vault create <type> <name>`       | Create a new vault      |
| Get secret   | `${{ vault.get(vault-name, key) }}` | `swamp vault get <vault-name> <key>`     | Retrieve a secret value |
| Store secret | N/A                                 | `swamp vault put <vault-name> key=value` | Store a secret value    |
| List vaults  | N/A                                 | `swamp vault search`                     | List all vaults         |
| List keys    | N/A                                 | `swamp vault list-keys <vault-name>`     | List all secret keys    |

### Error Handling

Vault operations include comprehensive error handling:

- **Missing Secrets**: Clear error messages with vault and key information
- **Authentication Failures**: Detailed credential configuration guidance
- **Network Errors**: Retry logic with exponential backoff for cloud vaults
- **Invalid Configuration**: Validation during vault initialization

## Environment Variables

For workflows, you should be able to reference other workflows by name or id, in
addition to any model.

You can access environment variables using the `env` namespace:

```yaml
attributes:
  region: ${{ env.AWS_REGION }}
  api_key: ${{ env.API_KEY }}
  path: /home/${{ env.USER }}/data
```

Environment variables are resolved at runtime from the process environment. This
allows configuration to be injected without hardcoding values in model inputs or
workflows.

Note: Accessing an undefined environment variable will result in a runtime error
during expression evaluation. Ensure required environment variables are set
before running workflows that depend on them.

## Workflow Example

End-to-end workflow for creating and running a new workflow:

1. **Get schema**: `swamp workflow schema get --json` (understand valid
   structure)
2. **Create** a new workflow: `swamp workflow create my-task --json`
3. **Edit** the YAML file at the returned `path` to add jobs and steps
4. **Validate** the workflow: `swamp workflow validate my-task --json`
5. **Fix** any validation errors and re-validate
6. **Run** the workflow: `swamp workflow run my-task --json`
