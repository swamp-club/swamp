# Vault Examples

## Table of Contents

- [Multi-Vault Setup](#multi-vault-setup)
- [Using Vaults in Models](#using-vaults-in-models)
- [Using Vaults in Workflows](#using-vaults-in-workflows)
- [Using User-Defined Vaults](#using-user-defined-vaults)
- [Migration Patterns](#migration-patterns)
- [Rotation Patterns](#rotation-patterns)

## Multi-Vault Setup

### Environment-Separated Vaults

Create separate vaults for each environment to isolate secrets:

```bash
# Development - local encryption for convenience
swamp vault create local_encryption dev-secrets --json

# Staging - local encryption for testing
swamp vault create local_encryption staging-secrets --json

# Production - AWS Secrets Manager for security
swamp vault create aws prod-secrets --json
```

Configure the production vault for AWS:

```bash
swamp vault edit prod-secrets
```

```yaml
id: 8f4e2d1c-9a3b-4c5d-ae7f-0a1b2c3d4e5f
name: prod-secrets
type: aws
config:
  region: us-east-1
  # Optional: use a specific AWS profile
  # profile: production
```

### Team-Based Vaults

Separate vaults by team or service:

```bash
swamp vault create local_encryption platform-secrets --json
swamp vault create local_encryption frontend-secrets --json
swamp vault create local_encryption backend-secrets --json
```

### Store Secrets

There are three ways to provide a secret value:

```bash
# 1. Inline KEY=VALUE
swamp vault put dev-secrets API_KEY=dev-key-12345 --json

# 2. Piped from stdin (useful in scripts/CI)
echo "dev-db-pass" | swamp vault put dev-secrets DB_PASSWORD --json
cat secret.txt | swamp vault put dev-secrets CERT --json

# 3. Interactive prompt (TTY only, value is hidden)
#    Just provide the key without a value — you'll be prompted:
#    $ swamp vault put dev-secrets API_KEY
#    Enter value for API_KEY: ********
swamp vault put dev-secrets API_KEY
```

```bash
# Dev environment
swamp vault put dev-secrets API_KEY=dev-key-12345 --json
swamp vault put dev-secrets DB_PASSWORD=dev-db-pass --json

# Staging environment
swamp vault put staging-secrets API_KEY=staging-key-67890 --json
swamp vault put staging-secrets DB_PASSWORD=staging-db-pass --json

# Production environment (via AWS)
swamp vault put prod-secrets API_KEY=prod-key-secure --json
swamp vault put prod-secrets DB_PASSWORD=prod-db-secure --json
```

## Using Vaults in Models

### Basic Secret Reference

```yaml
# models/api-client/input.yaml
name: api-client
version: 1
tags: {}
globalArguments:
  apiKey: ${{ vault.get("dev-secrets", "API_KEY") }}
  endpoint: https://api.example.com
```

### Multiple Secrets

```yaml
# models/database-connection/input.yaml
name: database-connection
version: 1
tags: {}
globalArguments:
  host: db.example.com
  port: 5432
  username: ${{ vault.get("dev-secrets", "DB_USERNAME") }}
  password: ${{ vault.get("dev-secrets", "DB_PASSWORD") }}
  database: myapp
```

### AWS Credentials from Vault

```yaml
# models/s3-uploader/input.yaml
name: s3-uploader
version: 1
tags: {}
globalArguments:
  bucket: my-bucket
  region: us-east-1
  accessKeyId: ${{ vault.get("aws-vault", "AWS_ACCESS_KEY_ID") }}
  secretAccessKey: ${{ vault.get("aws-vault", "AWS_SECRET_ACCESS_KEY") }}
```

## Using Vaults in Workflows

### Workflow with Vault Secrets

```yaml
# workflows/deploy-app/workflow.yaml
name: deploy-app
version: 1
inputs:
  properties:
    environment:
      type: string
      enum: ["dev", "staging", "production"]
  required: ["environment"]
jobs:
  - name: deploy
    steps:
      - name: deploy-service
        task:
          type: model_method
          modelIdOrName: deploy-service
          methodName: deploy
```

The model referenced by the workflow uses vault secrets:

```yaml
# models/deploy-service/input.yaml (for dev)
name: deploy-service
version: 1
tags: {}
globalArguments:
  deployKey: ${{ vault.get("dev-secrets", "DEPLOY_KEY") }}
  environment: dev
```

### Environment-Specific Model Instances

Create model instances per environment, each using the appropriate vault:

```yaml
# models/deploy-service-dev/input.yaml
name: deploy-service-dev
version: 1
tags:
  environment: dev
globalArguments:
  deployKey: ${{ vault.get("dev-secrets", "DEPLOY_KEY") }}
  endpoint: https://deploy.dev.example.com
```

```yaml
# models/deploy-service-prod/input.yaml
name: deploy-service-prod
version: 1
tags:
  environment: production
globalArguments:
  deployKey: ${{ vault.get("prod-secrets", "DEPLOY_KEY") }}
  endpoint: https://deploy.example.com
```

## Using User-Defined Vaults

### Setup and Usage

Create a user-defined vault implementation, then use it like any built-in vault:

```bash
# Create vault instance (user-defined types use --config)
swamp vault create @hashicorp/vault my-hcv \
  --config '{"address": "https://vault.example.com:8200", "path_prefix": "myapp/prod"}' --json

# Store and retrieve secrets
swamp vault put my-hcv db-password "s3cur3-p@ssw0rd" --json
swamp vault list-keys my-hcv --json
```

### User-Defined Vault in Workflows

```yaml
name: deploy-with-hcv
version: 1
jobs:
  - name: deploy
    steps:
      - name: run-deploy
        task:
          type: model_method
          modelIdOrName: deploy-service
          methodName: deploy
        env:
          DB_PASSWORD: ${{ vault.get(my-hcv, db-password) }}
          API_KEY: ${{ vault.get(my-hcv, api-key) }}
```

### Mixed Built-in and User-Defined Vaults

```bash
# Local vault for dev secrets
swamp vault create local_encryption dev-secrets --json

# HashiCorp Vault for production
swamp vault create @hashicorp/vault prod-hcv \
  --config '{"address": "https://vault.prod.internal:8200", "path_prefix": "prod"}' --json
```

Reference both in models:

```yaml
globalArguments:
  devKey: ${{ vault.get(dev-secrets, API_KEY) }}
  prodKey: ${{ vault.get(prod-hcv, API_KEY) }}
```

## Migration Patterns

### Migrating from Local to AWS Vault

**Step 1: Create AWS vault**

```bash
swamp vault create aws prod-secrets-aws --json
swamp vault edit prod-secrets-aws
```

Configure:

```yaml
id: 7a8b9c0d-1e2f-4a3b-4c5d-6e7f8a9b0c1d
name: prod-secrets-aws
type: aws
config:
  region: us-east-1
```

**Step 2: Copy secrets**

```bash
# Get secrets from local vault (one at a time for security)
swamp vault get prod-secrets API_KEY --json
# Copy the value

# Put into AWS vault
swamp vault put prod-secrets-aws API_KEY=<copied-value> --json
```

**Step 3: Update model references**

Update models to use the new vault name:

```yaml
# Before
apiKey: ${{ vault.get("prod-secrets", "API_KEY") }}

# After
apiKey: ${{ vault.get("prod-secrets-aws", "API_KEY") }}
```

**Step 4: Validate models**

```bash
swamp model validate --json
```

**Step 5: Test in staging first**

Run workflows with staging vault before switching production.

**Step 6: Delete old vault (optional)**

```bash
swamp vault delete prod-secrets --json
```

### Consolidating Multiple Vaults

**Scenario**: You have `api-secrets`, `db-secrets`, and `deploy-secrets` and
want to consolidate into `app-secrets`.

**Step 1: Create consolidated vault**

```bash
swamp vault create local_encryption app-secrets --json
```

**Step 2: Copy all secrets**

```bash
# From api-secrets
swamp vault list-keys api-secrets --json
# Copy each key

# From db-secrets
swamp vault list-keys db-secrets --json
# Copy each key
```

**Step 3: Update references**

Search for vault references in models:

```bash
grep -r "vault.get" models/
```

Update each model to use `app-secrets`.

## Rotation Patterns

### Manual Secret Rotation

**Step 1: Generate new secret value**

**Step 2: Update in vault**

```bash
swamp vault put prod-secrets API_KEY=new-key-value --json
```

**Step 3: Re-evaluate affected models**

```bash
# Find models using this vault
grep -r "prod-secrets" models/

# Re-evaluate them
swamp model evaluate model-1 --json
swamp model evaluate model-2 --json
```

**Step 4: Re-run workflows if needed**

### Rotation Workflow

Create a workflow that handles rotation:

```yaml
# workflows/rotate-secrets/workflow.yaml
name: rotate-secrets
version: 1
description: Rotate secrets and redeploy services
inputs:
  properties:
    secretName:
      type: string
    newValue:
      type: string
  required: ["secretName", "newValue"]
jobs:
  - name: update-secret
    steps:
      - name: store-new-secret
        task:
          type: model_method
          modelIdOrName: secret-updater
          methodName: update
          inputs:
            key: ${{ inputs.secretName }}
            value: ${{ inputs.newValue }}
  - name: redeploy
    dependsOn:
      - job: update-secret
        condition:
          type: succeeded
    steps:
      - name: deploy-services
        task:
          type: workflow
          workflowIdOrName: deploy-all-services
```

### Best Practices for Rotation

1. **Never hardcode secrets** — always use vault expressions
2. **Test rotation in staging** — verify workflows work with new secrets
3. **Monitor for failures** — watch for auth errors after rotation
4. **Keep old secrets temporarily** — allow rollback if issues arise
5. **Document rotation schedule** — establish regular rotation cadence
