# Model Outputs Reference

## Search Outputs

Find method execution outputs.

```bash
swamp model output search --json
swamp model output search "my-shell" --json
```

**Output shape:**

```json
{
  "query": "",
  "results": [
    {
      "outputId": "d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5",
      "modelName": "my-shell",
      "method": "execute",
      "status": "succeeded",
      "createdAt": "2025-01-15T10:30:00Z"
    }
  ]
}
```

## Get Output Details

Get full details of a specific output or latest output for a model.

```bash
swamp model output get d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5 --json
swamp model output get my-shell --json  # Latest output for model
```

**Output shape:**

```json
{
  "outputId": "d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5",
  "modelId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "modelName": "my-shell",
  "type": "command/shell",
  "method": "execute",
  "status": "succeeded",
  "startedAt": "2025-01-15T10:30:00Z",
  "completedAt": "2025-01-15T10:30:00.150Z",
  "artifacts": [
    { "type": "resource", "path": "..." }
  ]
}
```

## View Output Logs

Get log content from a method execution.

```bash
swamp model output logs d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5 --json
```

**Output shape:**

```json
{
  "outputId": "d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5",
  "logs": "Executing shell command...\nHello, world!\nCommand completed successfully."
}
```

## View Output Data

Get data artifact content from a method execution.

```bash
swamp model output data d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5 --json
```

**Output shape:**

```json
{
  "outputId": "d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5",
  "data": {
    "exitCode": 0,
    "command": "echo 'Hello, world!'",
    "executedAt": "2025-01-15T10:30:00Z"
  }
}
```
