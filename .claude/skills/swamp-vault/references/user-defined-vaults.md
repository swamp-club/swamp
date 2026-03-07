# User-Defined Vault Implementations

Create custom vault providers in `extensions/vaults/*.ts`. Swamp loads these at
startup and registers them alongside built-in vault types.

## Export Contract

Each file must export a `vault` object:

```typescript
import { z } from "npm:zod";

export const vault = {
  type: "@collective/name",       // Required: @collective/name format
  name: "Display Name",           // Required: human-readable name
  description: "What this does",  // Required: shown in CLI help
  configSchema: z.object({...}),  // Optional: Zod schema for config validation
  createProvider(name: string, config: Record<string, unknown>) {
    return {
      get(secretKey: string): Promise<string> { ... },
      put(secretKey: string, secretValue: string): Promise<void> { ... },
      list(): Promise<string[]> { ... },
      getName(): string { ... },
    };
  },
};
```

## Type Naming

- Must match `@collective/name` or `collective/name` pattern (e.g.,
  `@hashicorp/vault`, `hashicorp/vault`)
- Lowercase letters, numbers, and hyphens only
- Reserved collectives (`swamp`, `si`) are not allowed (with or without `@`
  prefix)

## File Location

| Priority | Source                         |
| -------- | ------------------------------ |
| 1        | `SWAMP_VAULTS_DIR` env var     |
| 2        | `vaultsDir` in `.swamp.yaml`   |
| 3        | `extensions/vaults/` (default) |

Files ending in `_test.ts` are excluded. Files without a `vault` export are
silently skipped (utility files).

## Creating an Instance

User-defined vaults require `--config` with a JSON object:

```bash
swamp vault create @hashicorp/vault my-hcv \
  --config '{"address": "https://vault.example.com:8200", "path_prefix": "myapp"}' --json
```

The config JSON is validated against `configSchema` if provided.

## Complete Example: HashiCorp Vault / OpenBao

```typescript
// extensions/vaults/hashicorp.ts
import { z } from "npm:zod";

class HashiCorpVaultProvider {
  private readonly name: string;
  private readonly address: string;
  private readonly tokenEnv: string;
  private readonly namespace?: string;
  private readonly mountPath: string;
  private readonly pathPrefix: string;

  constructor(name: string, config: Record<string, unknown>) {
    const c = config as {
      address: string;
      token_env?: string;
      namespace?: string;
      mount_path?: string;
      path_prefix?: string;
    };
    this.name = name;
    this.address = c.address.replace(/\/$/, "");
    this.tokenEnv = c.token_env ?? "VAULT_TOKEN";
    this.namespace = c.namespace;
    this.mountPath = c.mount_path ?? "secret";
    this.pathPrefix = c.path_prefix ?? "swamp";
  }

  getName(): string {
    return this.name;
  }

  async get(secretKey: string): Promise<string> {
    const resp = await fetch(
      `${this.address}/v1/${this.mountPath}/data/${this.pathPrefix}/${secretKey}`,
      { headers: this.headers() },
    );
    if (!resp.ok) {
      if (resp.status === 404) {
        throw new Error(
          `Secret '${secretKey}' not found in vault '${this.name}'`,
        );
      }
      throw new Error(`Failed to get '${secretKey}': ${resp.status}`);
    }
    const body = await resp.json();
    const value = (body.data?.data ?? body.data)?.value;
    if (value === undefined) {
      throw new Error(`Secret '${secretKey}' has no 'value' field`);
    }
    return value;
  }

  async put(secretKey: string, secretValue: string): Promise<void> {
    const resp = await fetch(
      `${this.address}/v1/${this.mountPath}/data/${this.pathPrefix}/${secretKey}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ data: { value: secretValue } }),
      },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to put '${secretKey}': ${text}`);
    }
  }

  async list(): Promise<string[]> {
    const resp = await fetch(
      `${this.address}/v1/${this.mountPath}/metadata/${this.pathPrefix}?list=true`,
      { headers: this.headers() },
    );
    if (!resp.ok) {
      if (resp.status === 404) return [];
      throw new Error(`Failed to list secrets: ${resp.status}`);
    }
    const body = await resp.json();
    return (body.data?.keys ?? [])
      .filter((k: string) => !k.endsWith("/"))
      .sort();
  }

  private headers(): Record<string, string> {
    const token = Deno.env.get(this.tokenEnv);
    if (!token) {
      throw new Error(`Set ${this.tokenEnv} environment variable`);
    }
    const h: Record<string, string> = {
      "X-Vault-Token": token,
      "Content-Type": "application/json",
    };
    if (this.namespace) h["X-Vault-Namespace"] = this.namespace;
    return h;
  }
}

export const vault = {
  type: "@hashicorp/vault",
  name: "HashiCorp Vault",
  description:
    "KV v2 secrets engine via HTTP API. Requires VAULT_TOKEN env var.",
  configSchema: z.object({
    address: z.string().url().describe("Vault server address"),
    token_env: z.string().optional().describe(
      "Env var for token (default: VAULT_TOKEN)",
    ),
    namespace: z.string().optional().describe("Vault namespace (enterprise)"),
    mount_path: z.string().optional().describe(
      "KV mount path (default: secret)",
    ),
    path_prefix: z.string().optional().describe("Path prefix (default: swamp)"),
  }),
  createProvider(name: string, config: Record<string, unknown>) {
    return new HashiCorpVaultProvider(name, config);
  },
};
```

Usage:

```bash
swamp vault create @hashicorp/vault my-hcv \
  --config '{"address": "https://vault.example.com:8200"}' --json

swamp vault put my-hcv db-password "s3cur3-p@ssw0rd" --json
swamp vault list-keys my-hcv --json
```

Works identically with OpenBao — just point `address` at the OpenBao server.

## Minimal Example: Environment Variable Vault

```typescript
// extensions/vaults/env_vault.ts
import { z } from "npm:zod";

export const vault = {
  type: "@myorg/env-vault",
  name: "Environment Variable Vault",
  description:
    "Read secrets from environment variables with a configurable prefix.",
  configSchema: z.object({
    prefix: z.string().optional().describe("Env var prefix (default: VAULT_)"),
  }),
  createProvider(name: string, config: Record<string, unknown>) {
    const prefix = (config.prefix as string) ?? "VAULT_";
    return {
      async get(key: string) {
        const val = Deno.env.get(`${prefix}${key}`);
        if (!val) throw new Error(`Env var ${prefix}${key} not set`);
        return val;
      },
      async put(_key: string, _value: string) {
        throw new Error("env-vault is read-only");
      },
      async list() {
        return Object.keys(Deno.env.toObject())
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length))
          .sort();
      },
      getName() {
        return name;
      },
    };
  },
};
```

## Key Rules

1. **Import**: Use `import { z } from "npm:zod";` (same as extension models)
2. **Export**: Must be `export const vault` (named export, not default)
3. **Collectives**: `swamp` and `si` collectives are reserved for built-in types
   (with or without `@` prefix)
4. **Config**: User-defined vaults always use `--config <json>` on
   `vault create`
5. **Bundling**: Files are bundled by Deno before import — standard Deno imports
   (`npm:`, `jsr:`, `https://`) all work
6. **Caching**: Bundles are cached in `.swamp/vault-bundles/` and rebuilt when
   source files change
