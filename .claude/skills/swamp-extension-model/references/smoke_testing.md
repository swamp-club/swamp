# Smoke-Test Protocol for Extension Models

Systematically verify extension models against live APIs before pushing. Unit
tests with mocked responses can't catch Content-Type mismatches, bundle caching
bugs, or API validation quirks that only surface with real HTTP calls.

## Protocol Phases

### Phase 0: Pre-flight

1. Read the extension model source to understand the API surface
2. `swamp model get <name> --json` to see configured methods and resource specs
3. Clear the **specific** bundle cache for the model under test:
   ```bash
   rm .swamp/bundles/<model-filename>.js
   ```
   For example, for `extensions/models/honeycomb.ts`, remove
   `.swamp/bundles/honeycomb.ts.js`. Do **not** wipe the entire
   `.swamp/bundles/` directory — other models have legitimate cached bundles.
4. Verify vault credentials are configured:
   `swamp vault get <vault-name> --json`

### Phase 0.5: API Contract Verification

Before running any methods, verify the model's API calls against the provider's
official REST API reference documentation. Mocked unit tests validate internal
logic but cannot catch contract mismatches that only surface with real HTTP
calls.

For each endpoint the model calls, verify:

1. **Endpoint URL pattern** — does the URL match the provider's documented path?
2. **HTTP method** — does the model use the correct verb (GET vs POST vs PUT vs
   PATCH vs DELETE)?
3. **Request body** — does the body schema match what the API expects? Some
   endpoints require an empty body, others require specific wrapper fields
4. **Response schema** — does the model parse the fields the API actually
   returns?
5. **Field naming conventions** — does the model match the provider's convention
   (camelCase vs snake_case vs PascalCase)?

If any mismatch is found, fix the model source **before** proceeding to Phase 1.

### Phase 1: List methods (safe reads)

- Run all `list`-kind methods — read-only, no side effects
- Try each `resource_type` the model supports
- **401/403 = expected signal** (endpoint works, token is scoped), not failure
- Connection errors or 500s = **stop**, API config is broken

```bash
swamp model method run <name> list
swamp model method run <name> list --arg resource_type=<type>
```

### Phase 2: Read methods

- Run `read`/`get`-kind methods using resource names/IDs from list results
- Verify response matches declared schema

```bash
swamp model method run <name> get --arg id=<id-from-list>
```

### Phase 3: Create lifecycle

For each resource type supporting create:

1. Use unique names: `smoke-test-{resource_type}-{timestamp}`
2. Read model source to determine required fields beyond `name` (this is where
   Claude's API understanding matters)
3. Run create, verify with read/get
4. **Track every created resource for cleanup**

```bash
swamp model method run <name> create \
  --arg name=smoke-test-widget-1711100000 \
  --arg <other-required-fields>
```

### Phase 4: Update lifecycle

- Only run if create succeeded
- Make a small change to verify the update path works

```bash
swamp model method run <name> update \
  --arg id=<created-id> \
  --arg description="smoke test update"
```

### Phase 5: Delete / cleanup (ALWAYS runs)

- Delete **every** resource created in Phase 3, in reverse order
- If delete fails (e.g., `delete_protected: true`), try the documented
  workaround (update to remove protection first, then delete)
- Verify deletion via read returning 404/not-found

```bash
swamp model method run <name> delete --arg id=<created-id>
# Verify deletion
swamp model method run <name> get --arg id=<created-id>
```

### Phase 6: Report

Produce a summary table:

| Method | Resource Type | Status | Notes                        |
| ------ | ------------- | ------ | ---------------------------- |
| list   | widget        | passed | 3 items returned             |
| get    | widget        | passed | schema matches               |
| create | widget        | passed | smoke-test-widget-1711100000 |
| update | widget        | passed | description updated          |
| delete | widget        | passed | verified 404                 |

**Result classifications:**

- **passed** — method succeeded as expected
- **expected_error** — 401/403 (endpoint works, token scoped)
- **failed** — unexpected error (real bug)
- **skipped** — couldn't run (missing args, dependent create failed)

**Flag specific bug categories:**

- Content-Type errors (415)
- Bundle cache issues (fix not reflected at runtime)
- Missing required fields (422)
- Read-only violations (405)

## Protocol Rules

1. **Never touch pre-existing resources** — only `smoke-test-*` named resources
2. **Always clean up**, even on failure
3. **Clear the specific model's bundle cache** (`.swamp/bundles/{filename}.js`)
   before every smoke test run — don't wipe the entire bundles directory
4. **Permission errors are signal, not failure** — 401/403 means the endpoint
   works but the token is scoped
5. **If unsure about required arguments, ask the user** rather than guessing

## Common Failure Patterns

These are the most frequent bugs caught by smoke testing (from real extension
model development):

### API contract mismatches

**Symptom:** API returns unexpected errors (400, 404, 405) or silently ignores
fields. Mocked unit tests pass but real API calls fail.

**Cause:** The model's HTTP calls don't match the provider's actual REST API
contract. Common examples:

- Using POST when the API expects GET (or vice versa)
- Sending a JSON body to an endpoint that requires an empty body
- Using camelCase field names when the API expects snake_case
- Missing required wrapper fields in the request body
- Parsing response fields that don't exist or have different names

**Fix:** Open the provider's official REST API reference documentation and
cross-reference each endpoint the model calls. Verify the HTTP method, request
body schema, and response schema match exactly. See Phase 0.5 in the protocol
above for the full checklist.

### Content-Type mismatches (HTTP 415)

**Symptom:** API returns 415 Unsupported Media Type.

**Cause:** The model sends the wrong `Content-Type` header (or none at all).
Many APIs require `application/json` explicitly.

**Fix:** Check the API docs for the required Content-Type and set it in the
fetch headers.

### Stale bundle cache

**Symptom:** A source fix isn't reflected at runtime — the model behaves as if
the old code is still running.

**Cause:** Swamp caches bundled model code in `.swamp/bundles/`. After editing
the source, the stale cached bundle is still used.

**Fix:** Remove the specific bundle:

```bash
rm .swamp/bundles/<model-filename>.js
```

### API validation quirks (HTTP 422)

**Symptom:** API returns 422 Unprocessable Entity with validation errors.

**Cause:** The API requires fields that aren't obvious from the primary docs
(e.g., a `type` field, a specific enum value, or a nested object structure).

**Fix:** Read the API's error response carefully — it usually lists the missing
or invalid fields. Update the model's create/update method to include them.

### Delete-protected defaults (HTTP 403/409)

**Symptom:** Delete method fails with 403 Forbidden or 409 Conflict.

**Cause:** The resource was created with delete protection enabled by default.

**Fix:** Update the resource to disable delete protection first, then retry the
delete:

```bash
swamp model method run <name> update --arg id=<id> --arg delete_protected=false
swamp model method run <name> delete --arg id=<id>
```

### Read-only resource guards (HTTP 405)

**Symptom:** Mutation method returns 405 Method Not Allowed.

**Cause:** The resource type is read-only (e.g., AWS managed policies, system
resources).

**Fix:** Mark the resource as read-only in the model — remove create/update/
delete methods for that resource type and only expose list/get.
