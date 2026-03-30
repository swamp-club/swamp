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
