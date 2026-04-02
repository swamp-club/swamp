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

When filing an issue for an official extension, prefix the title with the
extension name:

**Format:** `@collective/extension-name: brief description`

**Example bug:**

> **Title:**
> `@swamp/aws-ec2: describe method returns empty attributes for stopped instances`
>
> This bug affects the `@swamp/aws-ec2` extension's `describe` method. When an
> EC2 instance is in a stopped state, the method returns an empty attributes map
> instead of the instance metadata.
>
> The fix would involve updating the attribute mapping in the describe method to
> handle stopped-state API responses, which return a subset of fields.

**Example feature:**

> **Title:** `@swamp/aws-s3: add support for bucket lifecycle rules`
>
> This feature would add a `lifecycle` method to the `@swamp/aws-s3` extension
> model. Changes would be needed in:
>
> - New `lifecycle` method definition in the extension model
> - S3 lifecycle rule API integration
> - Output type definitions for lifecycle configuration
>
> The approach would follow the existing pattern used by the `policy` method for
> bucket policy management.
