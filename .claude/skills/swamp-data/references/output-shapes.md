# Data Command Output Shapes

JSON output shapes for `swamp data` commands when using `--json`.

## List Data

```json
{
  "modelId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "modelName": "my-model",
  "modelType": "my-type",
  "groups": [
    {
      "type": "log",
      "items": [
        {
          "id": "uuid",
          "name": "execution-log",
          "version": 5,
          "contentType": "text/plain",
          "type": "log",
          "streaming": false,
          "size": 1024,
          "createdAt": "2025-01-15T10:30:00Z"
        }
      ]
    },
    {
      "type": "resource",
      "items": [
        {
          "id": "uuid",
          "name": "state",
          "version": 3,
          "contentType": "application/json",
          "type": "resource",
          "streaming": false,
          "size": 512,
          "createdAt": "2025-01-15T10:30:00Z"
        }
      ]
    }
  ],
  "total": 2
}
```

## Get Data

```json
{
  "id": "uuid",
  "name": "execution-log",
  "modelId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "modelName": "my-model",
  "modelType": "my-type",
  "version": 5,
  "contentType": "text/plain",
  "lifetime": "7d",
  "garbageCollection": "infinite",
  "streaming": false,
  "tags": { "type": "resource" },
  "ownerDefinition": {
    "ownerType": "model-method",
    "ownerRef": "my-model:create",
    "definitionHash": "abc123..."
  },
  "createdAt": "2025-01-15T10:30:00Z",
  "size": 1024,
  "checksum": "sha256:...",
  "contentPath": ".swamp/data/my-type/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/execution-log/5/raw",
  "content": "..."
}
```

## Versions

```json
{
  "dataName": "state",
  "modelId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "modelName": "my-model",
  "modelType": "my-type",
  "versions": [
    {
      "version": 3,
      "createdAt": "2025-01-15T10:30:00Z",
      "size": 1024,
      "checksum": "sha256:...",
      "isLatest": true
    },
    {
      "version": 2,
      "createdAt": "2025-01-14T09:00:00Z",
      "size": 980,
      "checksum": "sha256:...",
      "isLatest": false
    },
    {
      "version": 1,
      "createdAt": "2025-01-13T08:00:00Z",
      "size": 512,
      "checksum": "sha256:...",
      "isLatest": false
    }
  ],
  "total": 3
}
```

## GC Dry-Run

```json
{
  "expiredDataCount": 2,
  "expiredData": [
    {
      "type": "my-type",
      "modelId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      "dataName": "cache",
      "reason": "lifetime:ephemeral"
    }
  ]
}
```

## GC Run

```json
{
  "dataEntriesExpired": 2,
  "versionsDeleted": 2,
  "bytesReclaimed": 15900000,
  "dryRun": false,
  "expiredEntries": [...]
}
```
