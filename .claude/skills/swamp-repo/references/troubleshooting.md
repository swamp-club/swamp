# Repository Troubleshooting

## Table of Contents

- [Common Errors](#common-errors)
  - ["Not a swamp repository"](#not-a-swamp-repository)
  - [Config File Issues](#config-file-issues)
  - [Skills Not Loading](#skills-not-loading)
  - [Stuck Datastore Lock](#stuck-datastore-lock)
- [Recovery Procedures](#recovery-procedures)

## Common Errors

### "Not a swamp repository"

**Symptom**: `Error: Not a swamp repository: /path/to/dir`

**Causes and solutions**:

1. **Repository not initialized**:

   ```bash
   swamp repo init --json
   ```

2. **Missing .swamp.yaml marker file**:

   ```bash
   # Check if marker exists
   ls -la .swamp.yaml

   # Reinitialize if missing
   swamp repo init --force --json
   ```

3. **Running from wrong directory**:

   ```bash
   # Verify you're in the right place
   pwd
   ls -la .swamp/
   ```

### Config File Issues

#### .swamp.yaml Corrupted

**Symptom**: Parse errors on any swamp command

**Diagnose**:

```bash
cat .swamp.yaml
# Check for YAML syntax errors
```

**Solution**: Fix the YAML or reinitialize:

```bash
swamp repo init --force --json
```

#### .swamp.yaml Missing Fields

**Symptom**: `Error: Missing required field: swampVersion`

**Solution**: Run upgrade to fix missing fields:

```bash
swamp repo upgrade --json
```

### Skills Not Loading

**Symptom**: Skills not available after init or upgrade

**Diagnose**:

```bash
ls -la .claude/skills/
```

**Solutions**:

1. **Run upgrade**:

   ```bash
   swamp repo upgrade --json
   ```

2. **Manual check**:

   ```bash
   # Verify skills directory structure
   find .claude/skills -name "SKILL.md"
   ```

3. **Reinitialize skills only**:

   ```bash
   swamp repo upgrade --json
   ```

### Stuck Datastore Lock

**Symptom**: `swamp` commands hang on `datastore·sync Pushing changes to ...`,
or fail with `SyncTimeoutError: Datastore push/pull timed out after Nms`, or
livelock on `Global lock held by <holder> appears stale ... — proceeding`
followed by repeated attempts to acquire.

**Cause**: A previous `swamp` process crashed or was killed before releasing the
datastore lock. The lock file/object in S3 or the filesystem still names a
holder that is no longer running.

**Diagnose**:

```bash
swamp datastore lock status
```

Shows the holder (hostname, pid, acquiredAt, ttlMs). If the holder is on a
host/runner that is no longer running, the lock is orphaned.

**Solutions**:

1. **Wait for TTL expiry**: Locks self-expire after `ttlMs` (30s default).
   Non-interactive — just wait.

2. **Force-release the global lock** (breakglass):

   ```bash
   swamp datastore lock release --force
   ```

   The `--force` flag is required. Bypasses `release()` and deletes the lock
   directly. Use when a crashed process left a lock that hasn't expired yet.

3. **Force-release a specific per-model lock**:

   ```bash
   swamp datastore lock release --force --model <type>/<id>
   ```

   Example: `swamp datastore lock release --force --model aws-ec2/my-server`.

**Related knobs**:

- `SWAMP_DATASTORE_SYNC_TIMEOUT_MS` — hard deadline per direction (push or pull)
  in milliseconds. Default 300000 (5 minutes). Increase for very large
  datastores on slow networks; decrease to fail faster in tight CI loops.

## Recovery Procedures

### Recover from Corrupted Repository

**Step 1: Backup current state**

```bash
cp -r .swamp/ .swamp.backup/
cp .swamp.yaml .swamp.yaml.backup
```

**Step 2: Reinitialize**

```bash
swamp repo init --force --json
```

**Step 3: Verify**

```bash
swamp model search --json
swamp workflow search --json
```

### Recover from Deleted .swamp Directory

If `.swamp/` was accidentally deleted but `models/`, `workflows/`, `vaults/`
symlinks still point to the old locations:

**Step 1: Check if data is truly gone**

```bash
ls -la models/
# If symlinks are broken, the data is gone
```

**Step 2: Reinitialize**

```bash
swamp repo init --force --json
```

**Step 3: Recreate models from source (if you have backups)**

If you have the model definition YAML files backed up:

```bash
# For each model definition
swamp model create <type> <name> --json
# Then edit to restore the configuration
```

### Recover from Git Merge Conflicts in .swamp

**Step 1: Resolve YAML conflicts manually**

Edit conflicting files in `.swamp/` to pick the correct version.

**Step 2: Validate all models**

```bash
swamp model validate --json
```

### Fix Permissions Issues

**Symptom**: Permission denied errors when reading/writing files

**Solution**:

```bash
# Fix ownership
chown -R $(whoami) .swamp/

# Fix permissions
chmod -R u+rw .swamp/

# Fix executable bits on directories
find .swamp -type d -exec chmod u+x {} \;
```

### Rebuild Everything from Scratch

**Nuclear option** — when nothing else works:

```bash
# 1. Backup any custom data
cp -r extensions/ extensions.backup/
cp -r models/ models.backup/ 2>/dev/null || true

# 2. Remove everything
rm -rf .swamp/ .claude/ models/ workflows/ vaults/ .swamp.yaml

# 3. Reinitialize
swamp repo init --json

# 4. Restore extensions
cp -r extensions.backup/* extensions/
```

**Note**: This loses all model data and workflow history. Only use as last
resort.
