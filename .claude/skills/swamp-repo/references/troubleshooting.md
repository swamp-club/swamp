# Repository Troubleshooting

## Table of Contents

- [Common Errors](#common-errors)
  - ["Not a swamp repository"](#not-a-swamp-repository)
  - [Broken Symlinks](#broken-symlinks)
  - [Index Out of Sync](#index-out-of-sync)
  - [Config File Issues](#config-file-issues)
  - [Skills Not Loading](#skills-not-loading)
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

### Broken Symlinks

**Symptom**: Commands fail with "file not found" or `ls` shows broken symlinks

**Diagnose**:

```bash
# Check for broken symlinks
swamp repo index --verify --json

# Manual check
find models/ -type l ! -exec test -e {} \; -print
```

**Solutions**:

1. **Prune broken symlinks**:

   ```bash
   swamp repo index --prune --json
   ```

2. **Full rebuild**:

   ```bash
   swamp repo index --json
   ```

3. **Verify internal data still exists**:

   ```bash
   ls -la .swamp/definitions/
   ls -la .swamp/data/
   ```

### Index Out of Sync

**Symptom**: Search results don't match actual files, or recent changes aren't
visible

**Causes**:

- Manual file edits without running `swamp repo index`
- Interrupted operations
- Git operations that modified `.swamp/` directly

**Solution**:

```bash
# Rebuild the index
swamp repo index --json
```

**Prevention**: After manual edits to `.swamp/` files, always run
`swamp repo index`.

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

**Step 2: Rebuild index**

```bash
swamp repo index --json
```

**Step 3: Validate all models**

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

# 5. Rebuild index
swamp repo index --json
```

**Note**: This loses all model data and workflow history. Only use as last
resort.
