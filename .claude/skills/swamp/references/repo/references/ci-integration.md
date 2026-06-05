# CI/CD Integration

## Installing Swamp in CI

The canonical install command is:

```bash
curl -fsSL https://swamp.club/install.sh | sh
```

### Installer Options

| Flag                        | Description            | Default                                     |
| --------------------------- | ---------------------- | ------------------------------------------- |
| `-d, --destination=<DEST>`  | Installation directory | `$HOME/bin` (or `/usr/local/bin` with sudo) |
| `-V, --version=<VERSION>`   | Release version        | `stable`                                    |
| `-p, --platform=<PLATFORM>` | Platform override      | Auto-detected                               |

### Pin a specific version

```bash
curl -fsSL https://swamp.club/install.sh | sh -s -- -V 20260320.184735.0
```

## GitHub Actions Example

```yaml
name: Swamp CI
on:
  pull_request:

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install swamp
        run: curl -fsSL https://swamp.club/install.sh | sh

      - name: Add swamp to PATH
        run: echo "$HOME/bin" >> "$GITHUB_PATH"

      - name: Run workflow
        run: swamp workflow run my-workflow
```

### With S3 datastore in CI

```yaml
- name: Run workflow with S3 datastore
  env:
    SWAMP_DATASTORE: s3:my-bucket/my-prefix
    AWS_REGION: us-east-1
  run: swamp workflow run my-workflow
```

### With version pinning

```yaml
- name: Install swamp (pinned)
  run: curl -fsSL https://swamp.club/install.sh | sh -s -- -V 20260320.184735.0
```

## IMPORTANT

- **NEVER fabricate installer URLs.** The only official installer is
  `https://swamp.club/install.sh`. There is no `https://get.swamp.club` or any
  other install endpoint.
- **NEVER invent a `setup-swamp` GitHub Action** — none exists. Use the curl
  installer shown above.
- The installer auto-detects platform (linux/darwin, x86_64/aarch64).
- The default install destination is `$HOME/bin` — add it to `$GITHUB_PATH` in
  GitHub Actions.
