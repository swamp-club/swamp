# Swamp Workflow Skill

Work with swamp workflows through the CLI. All commands support `--json` for
machine-readable output.

## CRITICAL: Workflow Creation Rules

- **Never generate workflow IDs** — no `uuidgen`, `crypto.randomUUID()`, or
  manual UUIDs. Swamp assigns IDs automatically via `swamp workflow create`.
- **Never write a workflow YAML file from scratch** — always use
  `swamp workflow create <name> --json` first, then edit the scaffold at the
  returned `path`, preserving the assigned `id`.
- **Never modify the `id` field** in an existing workflow file.
- **Verify CLI syntax**: If unsure about exact flags or subcommands, run
  `swamp help workflow` for the complete, up-to-date CLI schema.

Correct flow: `swamp workflow create <name> --json` → edit the YAML → validate →
run.

## Skill boundary

This skill produces a durable swamp workflow YAML under `workflows/` via
`swamp workflow create`. It is unrelated to the Claude Code Workflow tool /
dynamic workflows, to agent task lists (`TaskCreate`), to worktrees
(`EnterWorktree`), or to cron/remote-agent scheduling
(`CronCreate`/`RemoteTrigger`). If the user wants any of those, do not use this
skill.

## Quick Reference

| Task               | Command                                                       |
| ------------------ | ------------------------------------------------------------- |
| Get schema         | `swamp workflow schema get --json`                            |
| Search workflows   | `swamp workflow search [query] --json`                        |
| Get a workflow     | `swamp workflow get <id_or_name> --json`                      |
| Create a workflow  | `swamp workflow create <name> --json`                         |
| Edit a workflow    | `swamp workflow edit [id_or_name]`                            |
| Delete a workflow  | `swamp workflow delete <id_or_name> --json`                   |
| Validate workflow  | `swamp workflow validate [id_or_name] --json`                 |
| Evaluate workflow  | `swamp workflow evaluate <id_or_name> --json`                 |
| Run a workflow     | `swamp workflow run <id_or_name>`                             |
| Run with inputs    | `swamp workflow run <id_or_name> --input key=value`           |
| Run from stdin     | `echo '{"k":"v"}' \| swamp workflow run <id_or_name> --stdin` |
| Approve step       | `swamp workflow approve <workflow> <step>`                    |
| Reject step        | `swamp workflow reject <workflow> <step>`                     |
| Resume workflow    | `swamp workflow resume <workflow> [--input k=v]`              |
| List approvals     | `swamp workflow approvals`                                    |
| View run history   | `swamp workflow history search --json`                        |
| Get latest run     | `swamp workflow history get <workflow> --json`                |
| View run logs      | `swamp workflow history logs <run_or_workflow> --json`        |
| List workflow data | `swamp data list --workflow <name> --json`                    |
| Query wf data      | `swamp data query 'tags.workflow == "<name>"'`                |
| Get workflow data  | `swamp data get --workflow <name> <data_name> --json`         |

## Repository Structure

Workflow files are stored directly in the `workflows/` directory:

```
workflows/
  workflow-{uuid}.yaml
```

Internal data (evaluated workflows, run records) lives in `.swamp/`:

```
.swamp/workflows-evaluated/{uuid}.yaml
.swamp/workflow-runs/{workflow-id}/{run-id}.yaml
```

## IMPORTANT: Always Get Schema First

Before creating or editing a workflow file, ALWAYS get the schema first:

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
  "stepTask": {/* JSON Schema for task (model_method or workflow) */},
  "triggerCondition": {/* JSON Schema for dependency conditions */}
}
```

For detailed walkthroughs of each operation, see [reference.md](reference.md).
