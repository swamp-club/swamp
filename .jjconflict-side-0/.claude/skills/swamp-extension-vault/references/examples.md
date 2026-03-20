# Examples — Extension Vaults

## Minimal In-Memory Vault

A simple vault that stores secrets in memory (useful for testing):

```typescript
// extensions/vaults/memory-vault/mod.ts
import { z } from "npm:zod@4";

export const vault = {
  type: "@myorg/memory-vault",
  name: "Memory Vault",
  description: "Stores secrets in memory (for testing only)",
  createProvider: (name: string, _config: Record<string, unknown>) => {
    const secrets = new Map<string, string>();

    return {
      get: async (secretKey: string): Promise<string> => {
        const value = secrets.get(secretKey);
        if (value === undefined) {
          throw new Error(`Secret '${secretKey}' not found in vault '${name}'`);
        }
        return value;
      },
      put: async (secretKey: string, secretValue: string): Promise<void> => {
        secrets.set(secretKey, secretValue);
      },
      list: async (): Promise<string[]> => {
        return Array.from(secrets.keys());
      },
      getName: (): string => name,
    };
  },
};
```

### `.swamp.yaml` config

```yaml
vault:
  type: "@myorg/memory-vault"
```

## HTTP API Vault

A vault that connects to a REST API for secret management:

```typescript
// extensions/vaults/http-vault/mod.ts
import { z } from "npm:zod@4";

const ConfigSchema = z.object({
  endpoint: z.string().url().describe("Base URL of the secrets API"),
  token: z.string().describe("Authentication token"),
  namespace: z.string().default("default").describe("Secret namespace"),
});

export const vault = {
  type: "@myorg/http-vault",
  name: "HTTP Vault",
  description: "Retrieves and stores secrets via a REST API",
  configSchema: ConfigSchema,
  createProvider: (name: string, config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);
    const baseUrl = `${parsed.endpoint}/v1/namespaces/${parsed.namespace}`;
    const headers = {
      Authorization: `Bearer ${parsed.token}`,
      "Content-Type": "application/json",
    };

    return {
      get: async (secretKey: string): Promise<string> => {
        const response = await fetch(`${baseUrl}/secrets/${secretKey}`, {
          headers,
        });
        if (!response.ok) {
          throw new Error(
            `Failed to get secret '${secretKey}': HTTP ${response.status}`,
          );
        }
        const data = await response.json();
        return data.value;
      },
      put: async (secretKey: string, secretValue: string): Promise<void> => {
        const response = await fetch(`${baseUrl}/secrets/${secretKey}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ value: secretValue }),
        });
        if (!response.ok) {
          throw new Error(
            `Failed to put secret '${secretKey}': HTTP ${response.status}`,
          );
        }
      },
      list: async (): Promise<string[]> => {
        const response = await fetch(`${baseUrl}/secrets`, { headers });
        if (!response.ok) {
          throw new Error(
            `Failed to list secrets: HTTP ${response.status}`,
          );
        }
        const data = await response.json();
        return data.keys;
      },
      getName: (): string => name,
    };
  },
};
```

### `.swamp.yaml` config

```yaml
vault:
  type: "@myorg/http-vault"
  config:
    endpoint: "https://secrets.example.com"
    token: "my-auth-token"
    namespace: "production"
```

## File-Based Vault with Encryption

A vault that stores encrypted secrets in local files:

```typescript
// extensions/vaults/encrypted-file/mod.ts
import { z } from "npm:zod@4";

const ConfigSchema = z.object({
  path: z.string().describe("Directory to store encrypted secret files"),
  encryptionKey: z.string().min(32).describe("Base64-encoded encryption key"),
});

export const vault = {
  type: "@myorg/encrypted-file",
  name: "Encrypted File Vault",
  description: "Stores secrets as encrypted files on the local filesystem",
  configSchema: ConfigSchema,
  createProvider: (name: string, config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);

    const encrypt = async (plaintext: string): Promise<string> => {
      const keyBytes = Uint8Array.from(
        atob(parsed.encryptionKey),
        (c) => c.charCodeAt(0),
      );
      const key = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        "AES-GCM",
        false,
        ["encrypt"],
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(plaintext),
      );
      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(encrypted), iv.length);
      return btoa(String.fromCharCode(...combined));
    };

    const decrypt = async (ciphertext: string): Promise<string> => {
      const keyBytes = Uint8Array.from(
        atob(parsed.encryptionKey),
        (c) => c.charCodeAt(0),
      );
      const key = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        "AES-GCM",
        false,
        ["decrypt"],
      );
      const combined = Uint8Array.from(
        atob(ciphertext),
        (c) => c.charCodeAt(0),
      );
      const iv = combined.slice(0, 12);
      const data = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        data,
      );
      return new TextDecoder().decode(decrypted);
    };

    return {
      get: async (secretKey: string): Promise<string> => {
        const filePath = `${parsed.path}/${secretKey}.enc`;
        try {
          const encrypted = await Deno.readTextFile(filePath);
          return await decrypt(encrypted);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            throw new Error(`Secret '${secretKey}' not found`);
          }
          throw error;
        }
      },
      put: async (secretKey: string, secretValue: string): Promise<void> => {
        await Deno.mkdir(parsed.path, { recursive: true });
        const encrypted = await encrypt(secretValue);
        await Deno.writeTextFile(`${parsed.path}/${secretKey}.enc`, encrypted);
      },
      list: async (): Promise<string[]> => {
        const keys: string[] = [];
        try {
          for await (const entry of Deno.readDir(parsed.path)) {
            if (entry.isFile && entry.name.endsWith(".enc")) {
              keys.push(entry.name.replace(/\.enc$/, ""));
            }
          }
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            return [];
          }
          throw error;
        }
        return keys.sort();
      },
      getName: (): string => name,
    };
  },
};
```

### `.swamp.yaml` config

```yaml
vault:
  type: "@myorg/encrypted-file"
  config:
    path: "/home/user/.swamp-secrets"
    encryptionKey: "base64encodedkey32bytesminimum=="
```
