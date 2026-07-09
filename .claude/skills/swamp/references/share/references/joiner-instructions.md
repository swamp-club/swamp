# Joiner Instructions Template

Generate copy-pasteable onboarding instructions tailored to the actual repo
configuration. Read `.swamp.yaml` and vault configs to determine what
credentials the teammate needs.

## Template

Adapt the sections below based on what the repo actually uses. Omit sections
that don't apply.

---

### Prerequisites

**Clone the repository:**

```bash
git clone <REPO_URL>
cd <REPO_NAME>
```

**Install swamp:**

```bash
curl -fsSL https://get.swamp.club | bash
```

**Authenticate with swamp-club (optional, for extensions):**

```bash
swamp auth login
```

### Datastore Access

_Include this section when the datastore is not `filesystem`._

**For `@swamp/s3-datastore`:**

You need AWS credentials with read/write access to the S3 bucket. Configure your
AWS credentials via any standard method (`~/.aws/credentials`, environment
variables, IAM role, SSO):

```
Bucket: <BUCKET>
Prefix: <PREFIX>
Region: <REGION>
```

The first `swamp` command that touches data will auto-hydrate the local cache
from S3. This may take a moment on the first run.

**For other datastore extensions:**

You need credentials for the datastore provider. Check with the repo owner for
the specific requirements.

### Vault Access

_Include this section for each vault that is NOT `local_encryption`._

**For `@swamp/aws-sm` vaults:**

You need AWS credentials with access to AWS Secrets Manager in the configured
region. The vault secrets are stored remotely — no local setup needed beyond AWS
credentials.

**For `@swamp/azure-kv` vaults:**

You need Azure credentials with access to the configured Azure Key Vault
instance.

**For `@swamp/1password` vaults:**

You need the 1Password CLI installed and a service account token for the
configured vault.

### Extensions

Extensions auto-install on first use. The `@swamp/*` official extensions are
trusted by default. The repo's `upstream_extensions.json` lockfile pins exact
versions so everyone uses the same extension builds.

No manual extension setup is needed.

### Verify Setup

After cloning and configuring credentials, verify everything works:

```bash
swamp doctor datastores    # check datastore connectivity
swamp doctor vaults        # check vault access
swamp model search         # list available models
```

---

## Customization Notes

- **Always fill in actual values** from the repo config — don't use generic
  placeholders unless the value is truly unknown.
- **Omit vault access section** if the repo has no vaults or all vaults are
  `local_encryption` (which should not happen after sharing setup).
- **Omit datastore access section** if the datastore is `filesystem` (which
  should not happen after sharing setup — but may apply if only vaults were
  migrated and data is shared via git).
- **Add namespace info** if the repo uses a namespace: mention it so the
  teammate understands the multi-repo setup.
