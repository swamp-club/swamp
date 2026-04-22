# Formatting Issue Content

## Bug Reports

Provide a summary of the work involved to fix the bug:

- Describe what component is affected
- Outline the expected fix approach at a high level
- Do NOT include specific code implementations

**Example summary:**

> This bug affects the workflow execution service when input files are missing.
> The fix would involve adding validation in the input resolution phase before
> job execution begins, with a clear error message pointing to the missing file.

## Feature Requests

Provide a summary of the implementation plan:

- Describe the scope of changes needed
- List affected components
- Outline the high-level approach
- Do NOT include specific code implementations

**Example summary:**

> This feature would add a `--dry-run` flag to the `workflow run` command.
> Changes would be needed in:
>
> - Command option parsing (workflow_run.ts)
> - Execution service to skip actual method calls
> - Output rendering to show what would be executed
>
> The approach would intercept execution at the method call boundary and display
> the planned actions without making external calls.

## Extension Issues

Prefer `--extension @collective/name` when filing against a specific extension.
The CLI attaches the extension name, installed version, and a `## Environment`
section to the body automatically — do **not** also prefix the title with the
extension name, because it would be redundant.

**Example bug (using `--extension`):**

```bash
swamp issue bug --extension @swamp/aws-ec2 \
  --title "describe method returns empty attributes for stopped instances" \
  --body "$(cat <<'EOF'
The describe method returns an empty attributes map when an EC2 instance is
in a stopped state, instead of the instance metadata.

The fix would involve updating the attribute mapping in the describe method
to handle stopped-state API responses, which return a subset of fields.
EOF
)"
```

**When `--extension` isn't an option** (e.g. the extension isn't pulled and
won't be, or filing via `--email`), fall back to prefixing the title with the
extension name so readers can still identify scope:

**Format:** `@collective/extension-name: brief description`

**Example:**

> **Title:**
> `@swamp/aws-ec2: describe method returns empty attributes for stopped instances`
>
> The describe method returns an empty attributes map when an EC2 instance is in
> a stopped state, instead of the instance metadata.
>
> The fix would involve updating the attribute mapping in the describe method to
> handle stopped-state API responses, which return a subset of fields.
