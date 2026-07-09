# Share — Troubleshooting

Common failures during the solo-to-team sharing setup and how to recover.

## Datastore Setup Failures

### S3: Access Denied / No Such Bucket

```
error: S3 health check failed: Access Denied
```

**Cause:** AWS credentials don't have permission to access the bucket, or the
bucket doesn't exist.

**Fix:**

1. Verify the bucket exists: `aws s3 ls s3://<bucket>/`
2. Check IAM permissions — swamp needs `s3:GetObject`, `s3:PutObject`,
   `s3:ListBucket`, `s3:DeleteObject`
3. Verify the region matches the bucket's actual region
4. Re-run `swamp datastore setup`

### S3-Compatible (MinIO, etc.): Connection Refused

```
error: AggregateError / ECONNREFUSED
```

**Cause:** The S3-compatible endpoint (MinIO, Ceph, etc.) is not reachable.

**Fix:**

1. Verify the service is running: `docker ps | grep minio` or
   `curl http://localhost:9000/minio/health/live`
2. Check the endpoint URL and port in your config
3. Make sure `forcePathStyle: true` is set in the config — required for MinIO
4. Set the correct credentials:
   `export AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin` (or
   whatever your MinIO credentials are)

Example config for MinIO:

```json
{
  "bucket": "my-bucket",
  "region": "us-east-1",
  "endpoint": "http://localhost:9000",
  "forcePathStyle": true
}
```

### S3: Invalid Region

```
error: S3 health check failed: ... PermanentRedirect ...
```

**Cause:** The configured region doesn't match the bucket's region.

**Fix:** Find the correct region with
`aws s3api get-bucket-location --bucket <bucket>` and re-run setup with the
right region.

### Extension Not Found

```
error: Datastore type "@swamp/s3-datastore" not found
```

**Cause:** The S3 datastore extension is not installed.

**Fix:**

```bash
swamp extension pull @swamp/s3-datastore
swamp datastore setup
```

### Datastore Already Configured

If the repo already has a non-filesystem datastore and you want to change it,
you need to reinitialize:

```bash
swamp repo init --force
```

This resets the datastore to filesystem. Then run `swamp datastore setup` again.

## Vault Migration Failures

### Pre-Flight Auth Checks

**Always verify provider auth before attempting migration.** Run the appropriate
check and resolve any issues before calling `swamp vault migrate`:

| Provider            | Auth check command            | What to fix                                   |
| ------------------- | ----------------------------- | --------------------------------------------- |
| 1Password           | `op whoami`                   | `op signin` or set `OP_SERVICE_ACCOUNT_TOKEN` |
| AWS Secrets Manager | `aws sts get-caller-identity` | Configure AWS credentials                     |
| Azure Key Vault     | `az account show`             | `az login`                                    |

### Provider Credentials Missing

```
error: Failed to connect to AWS Secrets Manager
```

**Cause:** The target vault provider's credentials are not configured on this
machine. The pre-flight auth check (see above) should catch this before the
migration runs.

**Fix:** Configure credentials for the target provider, verify with the auth
check command above, then re-run the saved migration command.

### Same Type Migration

```
error: Source and target vault types are the same
```

**Cause:** The vault is already on the target provider.

**Fix:** This vault doesn't need migration. Skip it.

### Secret Copy Failure

If the migration fails partway through copying secrets, the source vault is
unchanged — secrets are copied, not moved. Re-run the migration to retry.

### Vault Extension Not Found

```
error: Vault type "@swamp/aws-sm" not found
```

**Fix:**

```bash
swamp extension pull @swamp/aws-sm
swamp vault migrate <vault> --to-type @swamp/aws-sm
```

## General Issues

### Not in a Swamp Repo

```
error: Not a swamp repository
```

**Fix:** Run `swamp repo init` first, or navigate to the repo root.

### Worktree Issues

If running from a Claude Code worktree (`.claude/worktrees/`), add `--repo-dir`
pointing to the main repo:

```bash
swamp datastore status --repo-dir /path/to/main/repo --json
```

### Partial Completion

If you completed some steps but not all, just re-run the share flow. The assess
step detects current state:

- Datastore already external? Skip datastore step.
- Some vaults migrated, some not? Only show the remaining ones.
- Everything done? Offer joiner instructions.
