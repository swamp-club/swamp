// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

/**
 * Embedded runner script executed inside Docker containers for bundle mode.
 *
 * The runner:
 * 1. Reads `/swamp/request.json` for method name and args
 * 2. Dynamically imports `/swamp/bundle.js` (self-contained, zod inlined)
 * 3. Creates a mock context that captures writeResource/createFileWriter calls
 * 4. Executes the requested method
 * 5. Outputs `{ resources, files }` JSON to stdout
 * 6. Logs go to stderr (captured by the Docker driver as real-time logs)
 *
 * The container must have Deno installed (e.g., `denoland/deno:alpine`).
 */
export const DOCKER_RUNNER_SCRIPT = `\
// Runner script for swamp Docker bundle execution
// This file is generated — do not edit manually.

// Chunked base64 encoder safe for large buffers (avoids spread RangeError)
function toBase64(bytes) {
  const CHUNK = 32768;
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.slice(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

const request = JSON.parse(await Deno.readTextFile("/swamp/request.json"));

const { model } = await import("/swamp/bundle.js");

const method = model.methods[request.methodName];
if (!method) {
  console.error(\`Method '\${request.methodName}' not found in model\`);
  Deno.exit(1);
}

const resources = [];
const files = [];

const context = {
  repoDir: "/swamp",
  modelType: request.modelType ?? "unknown",
  modelId: request.modelId ?? "unknown",
  globalArgs: request.globalArgs ?? {},
  methodName: request.methodName,
  definition: request.definitionMeta ?? {
    id: "unknown",
    name: "unknown",
    version: 1,
    tags: {},
  },
  logger: {
    debug: (...args) => console.error("[DEBUG]", ...args),
    info: (...args) => console.error("[INFO]", ...args),
    warn: (...args) => console.error("[WARN]", ...args),
    error: (...args) => console.error("[ERROR]", ...args),
  },
  writeResource: async (specName, name, data) => {
    resources.push({ specName, name, data });
    return {
      dataId: crypto.randomUUID(),
      name,
      specName,
      kind: "resource",
      version: 1,
      size: 0,
      tags: {},
      metadata: {},
    };
  },
  createFileWriter: (specName, name) => {
    const chunks = [];
    return {
      dataId: crypto.randomUUID(),
      name,
      writeAll: async (content) => {
        // Base64 encode binary content for JSON transport
        const b64 = typeof content === "string"
          ? btoa(content)
          : toBase64(new Uint8Array(content));
        files.push({ specName, name, content: b64 });
        return {
          dataId: crypto.randomUUID(),
          name,
          specName,
          kind: "file",
          version: 1,
          size: content.length,
          tags: {},
          metadata: {},
        };
      },
      writeText: async (text) => {
        files.push({ specName, name, content: btoa(text) });
        return {
          dataId: crypto.randomUUID(),
          name,
          specName,
          kind: "file",
          version: 1,
          size: text.length,
          tags: {},
          metadata: {},
        };
      },
      writeLine: async (line) => {
        chunks.push(line);
      },
      writeStream: async (stream) => {
        const reader = stream.getReader();
        const parts = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
        }
        const merged = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let offset = 0;
        for (const part of parts) {
          merged.set(part, offset);
          offset += part.length;
        }
        files.push({
          specName,
          name,
          content: toBase64(merged),
        });
        return {
          dataId: crypto.randomUUID(),
          name,
          specName,
          kind: "file",
          version: 1,
          size: merged.length,
          tags: {},
          metadata: {},
        };
      },
      getFilePath: async () => {
        throw new Error("getFilePath is not supported in Docker bundle mode");
      },
      finalize: async () => {
        const text = chunks.join("\\n");
        files.push({ specName, name, content: btoa(text) });
        return {
          dataId: crypto.randomUUID(),
          name,
          specName,
          kind: "file",
          version: 1,
          size: text.length,
          tags: {},
          metadata: {},
        };
      },
    };
  },
};

try {
  await method.execute(request.methodArgs ?? {}, context);
} catch (err) {
  console.error(\`Execution error: \${err.message ?? err}\`);
  Deno.exit(2);
}

console.log(JSON.stringify({ resources, files }));
`;
