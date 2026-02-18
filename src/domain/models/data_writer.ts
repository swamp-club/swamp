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

import { z } from "zod";
import { getLogger } from "@logtape/logtape";
import { Data } from "../data/mod.ts";
import type { DataId, OwnerDefinition } from "../data/mod.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { ModelType } from "./model_type.ts";
import type {
  DataHandle,
  DataWriter,
  DataWriterCallbacks,
  FileOutputSpec,
  FileWriterOverrides,
  ResolvedDataWriterOptions,
  ResourceOutputSpec,
  ResourceWriteOverrides,
} from "./model.ts";
import type { GarbageCollectionPolicy, Lifetime } from "../data/mod.ts";

const logger = getLogger(["swamp", "data-writer"]);

/**
 * Default implementation of the DataWriter domain service.
 *
 * Writes data directly to disk during method execution, returning
 * lightweight DataHandle references instead of buffering full content.
 */
export class DefaultDataWriter implements DataWriter {
  readonly dataId: DataId;
  readonly name: string;

  private readonly repo: UnifiedDataRepository;
  private readonly modelType: ModelType;
  private readonly modelId: string;
  private readonly options: ResolvedDataWriterOptions;
  private readonly callbacks: DataWriterCallbacks;

  private allocated: { version: number; contentPath: string } | null = null;
  private data: Data | null = null;
  private lineBuffer: string[] | null = null;
  private finalized = false;

  constructor(
    repo: UnifiedDataRepository,
    modelType: ModelType,
    modelId: string,
    options: ResolvedDataWriterOptions,
    callbacks: DataWriterCallbacks = {},
  ) {
    this.repo = repo;
    this.modelType = modelType;
    this.modelId = modelId;
    this.options = options;
    this.callbacks = callbacks;
    this.dataId = repo.nextId();
    this.name = options.name;
  }

  async writeAll(content: Uint8Array): Promise<DataHandle> {
    this.ensureNotFinalized();
    const data = this.createDataEntity();

    const saveResult = await this.repo.save(
      this.modelType,
      this.modelId,
      data,
      content,
    );

    this.finalized = true;
    return this.buildHandle(saveResult.version, content.length);
  }

  writeText(text: string): Promise<DataHandle> {
    return this.writeAll(new TextEncoder().encode(text));
  }

  async writeLine(line: string): Promise<void> {
    this.ensureNotFinalized();

    if (!this.allocated) {
      // First call: allocate version and create initial empty file
      const data = this.createDataEntity();
      this.data = data;
      this.allocated = await this.repo.allocateVersion(
        this.modelType,
        this.modelId,
        data,
      );
      // Write empty file to create it
      await Deno.writeFile(this.allocated.contentPath, new Uint8Array());
      this.lineBuffer = [];
    }

    // Append line
    const lineContent = line + "\n";
    const file = await Deno.open(this.allocated.contentPath, { append: true });
    try {
      await file.write(new TextEncoder().encode(lineContent));
    } finally {
      file.close();
    }

    this.lineBuffer!.push(line);

    // Invoke callback
    if (this.callbacks.onLine) {
      this.callbacks.onLine(this.name, line);
    }
  }

  async writeStream(
    stream: ReadableStream<Uint8Array>,
    options?: { onLine?: (line: string) => void },
  ): Promise<DataHandle> {
    this.ensureNotFinalized();

    const data = this.createDataEntity();
    this.data = data;
    this.allocated = await this.repo.allocateVersion(
      this.modelType,
      this.modelId,
      data,
    );

    // Open file for writing
    const file = await Deno.open(this.allocated.contentPath, {
      write: true,
      create: true,
      truncate: true,
    });

    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Write raw bytes to file
        await file.write(value);

        // Decode for line callbacks if needed
        if (options?.onLine || this.callbacks.onLine) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");

          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i];
            options?.onLine?.(line);
            this.callbacks.onLine?.(this.name, line);
          }

          buffer = lines[lines.length - 1];
        }
      }

      // Process remaining buffer
      if (buffer && (options?.onLine || this.callbacks.onLine)) {
        options?.onLine?.(buffer);
        this.callbacks.onLine?.(this.name, buffer);
      }
    } finally {
      file.close();
    }

    return this.finalize();
  }

  async getFilePath(): Promise<string> {
    this.ensureNotFinalized();

    if (!this.allocated) {
      const data = this.createDataEntity();
      this.data = data;
      this.allocated = await this.repo.allocateVersion(
        this.modelType,
        this.modelId,
        data,
      );
    }

    return this.allocated.contentPath;
  }

  async finalize(): Promise<DataHandle> {
    this.ensureNotFinalized();

    if (!this.allocated || !this.data) {
      throw new Error(
        `DataWriter "${this.name}" has not been used — nothing to finalize`,
      );
    }

    const { size, checksum: _checksum } = await this.repo.finalizeVersion(
      this.modelType,
      this.modelId,
      this.data,
      this.allocated.version,
    );

    this.finalized = true;
    return this.buildHandle(this.allocated.version, size);
  }

  private get ownerDefinition(): OwnerDefinition {
    return this.options.ownerDefinition ?? {
      ownerType: "model-method",
      ownerRef: this.modelId,
    };
  }

  private createDataEntity(): Data {
    return Data.create({
      id: this.dataId,
      name: this.options.name,
      version: 1, // Will be updated by repo operations
      contentType: this.options.contentType,
      lifetime: this.options.lifetime,
      garbageCollection: this.options.garbageCollection,
      streaming: this.options.streaming ?? false,
      tags: this.options.tags,
      ownerDefinition: this.ownerDefinition,
    });
  }

  private buildHandle(version: number, size: number): DataHandle {
    return {
      name: this.options.name,
      specName: this.options.specName,
      kind: this.options.kind,
      dataId: this.dataId,
      version,
      size,
      tags: { ...this.options.tags },
      metadata: {
        contentType: this.options.contentType,
        lifetime: this.options.lifetime,
        garbageCollection: this.options.garbageCollection,
        streaming: this.options.streaming ?? false,
        tags: { ...this.options.tags },
        ownerDefinition: { ...this.ownerDefinition },
      },
    };
  }

  private ensureNotFinalized(): void {
    if (this.finalized) {
      throw new Error(
        `DataWriter "${this.name}" has already been finalized`,
      );
    }
  }
}

/**
 * Creates a writeResource function bound to a specific execution context.
 *
 * The returned function validates data against the resource's Zod schema (warn on failure),
 * serializes to JSON, writes via DefaultDataWriter, and returns a DataHandle.
 *
 * @param repo - The unified data repository
 * @param modelType - The model type
 * @param modelId - The model ID (definition ID)
 * @param resources - The model's declared resource output specifications
 * @param tagOverrides - Tags merged into every writer (e.g., workflow step tags)
 * @param dataOutputOverrides - Overrides for specific spec names
 * @returns A tuple of [writeResource, getHandles]
 */
export function createResourceWriter(
  repo: UnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
  resources: Record<string, ResourceOutputSpec>,
  tagOverrides?: Record<string, string>,
  dataOutputOverrides?: Array<{
    specName: string;
    lifetime?: Lifetime;
    garbageCollection?: GarbageCollectionPolicy;
    tags?: Record<string, string>;
  }>,
  definitionTags?: Record<string, string>,
  runtimeTags?: Record<string, string>,
  definitionName?: string,
): {
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: ResourceWriteOverrides,
  ) => Promise<DataHandle>;
  getHandles: () => DataHandle[];
} {
  const handles: DataHandle[] = [];

  const writeResource = async (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: ResourceWriteOverrides,
  ): Promise<DataHandle> => {
    const spec = resources[specName];
    if (!spec) {
      const declared = Object.keys(resources).join(", ");
      throw new Error(
        `Undeclared resource spec '${specName}' in model '${modelType.normalized}'. ` +
          `Declared resource specs: ${declared || "(none)"}`,
      );
    }

    // Validate data against schema (warn on failure, don't throw)
    const validationResult = spec.schema.safeParse(data);
    if (!validationResult.success) {
      const formattedError = validationResult.error instanceof z.ZodError
        ? validationResult.error.issues.map((i: z.ZodIssue) =>
          `${i.message} at "${i.path.join(".")}"`
        ).join("; ")
        : String(validationResult.error);
      logger.warn(
        "Resource '{specName}' data does not match schema: {error}",
        { specName, error: formattedError },
      );
    }

    // Validate name is non-empty
    if (name.trim() === "") {
      throw new Error(
        `Resource name must be a non-empty string for spec '${specName}' ` +
          `in model '${modelType.normalized}'`,
      );
    }

    const instanceName = name;

    // Resolve tags with full resolution chain:
    // 1. type auto-tag → 2. definition tags → 3. spec defaults →
    // 4. method overrides → 5. specName auto-tag → 6. workflow/tag overrides →
    // 7. runtime tags → 8. data output overrides
    const resolvedTags: Record<string, string> = {
      type: "resource",
      ...(definitionTags ?? {}),
      ...(spec.tags ?? {}),
      ...(overrides?.tags ?? {}),
    };

    // Auto-inject specName tag for findBySpec discovery
    resolvedTags["specName"] = specName;

    // Auto-inject modelName tag for orphan data recovery (issue #370)
    if (definitionName) {
      resolvedTags["modelName"] = definitionName;
    }

    // Apply global tag overrides (workflow step tags)
    if (tagOverrides) {
      Object.assign(resolvedTags, tagOverrides);
    }

    // Apply runtime tags (--tag flags)
    if (runtimeTags) {
      Object.assign(resolvedTags, runtimeTags);
    }

    // Resolve lifetime and gc with overrides
    let lifetime = overrides?.lifetime ?? spec.lifetime;
    let garbageCollection = overrides?.garbageCollection ??
      spec.garbageCollection;

    // Apply data output overrides for this spec name
    if (dataOutputOverrides) {
      const override = dataOutputOverrides.find(
        (o) => o.specName === specName,
      );
      if (override) {
        lifetime = override.lifetime ?? lifetime;
        garbageCollection = override.garbageCollection ?? garbageCollection;
        if (override.tags) {
          Object.assign(resolvedTags, override.tags);
        }
      }
    }

    const resolvedOptions: ResolvedDataWriterOptions = {
      name: instanceName,
      specName,
      kind: "resource",
      contentType: "application/json",
      lifetime,
      garbageCollection,
      tags: resolvedTags,
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: modelId,
      },
    };

    const writer = new DefaultDataWriter(
      repo,
      modelType,
      modelId,
      resolvedOptions,
    );

    const handle = await writer.writeText(JSON.stringify(data));
    handles.push(handle);
    return handle;
  };

  return { writeResource, getHandles: () => [...handles] };
}

/**
 * Creates a createFileWriter function bound to a specific execution context.
 *
 * The returned function creates DefaultDataWriter instances for writing
 * binary/streaming file content.
 *
 * @param repo - The unified data repository
 * @param modelType - The model type
 * @param modelId - The model ID (definition ID)
 * @param files - The model's declared file output specifications
 * @param tagOverrides - Tags merged into every writer (e.g., workflow step tags)
 * @param dataOutputOverrides - Overrides for specific spec names
 * @param callbacks - Optional callbacks for streaming events
 * @returns A tuple of [createFileWriter, getHandles]
 */
export function createFileWriterFactory(
  repo: UnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
  files: Record<string, FileOutputSpec>,
  tagOverrides?: Record<string, string>,
  dataOutputOverrides?: Array<{
    specName: string;
    lifetime?: Lifetime;
    garbageCollection?: GarbageCollectionPolicy;
    tags?: Record<string, string>;
  }>,
  callbacks?: DataWriterCallbacks,
  definitionTags?: Record<string, string>,
  runtimeTags?: Record<string, string>,
  definitionName?: string,
): {
  createFileWriter: (
    specName: string,
    name: string,
    overrides?: FileWriterOverrides,
  ) => DataWriter;
  getHandles: () => DataHandle[];
} {
  const handles: DataHandle[] = [];
  const writers: DefaultDataWriter[] = [];

  const createFileWriter = (
    specName: string,
    name: string,
    overrides?: FileWriterOverrides,
  ): DataWriter => {
    const spec = files[specName];
    if (!spec) {
      const declared = Object.keys(files).join(", ");
      throw new Error(
        `Undeclared file spec '${specName}' in model '${modelType.normalized}'. ` +
          `Declared file specs: ${declared || "(none)"}`,
      );
    }

    // Validate name is non-empty
    if (name.trim() === "") {
      throw new Error(
        `File name must be a non-empty string for spec '${specName}' ` +
          `in model '${modelType.normalized}'`,
      );
    }

    const instanceName = name;

    // Resolve tags with full resolution chain:
    // 1. type auto-tag → 2. definition tags → 3. spec defaults →
    // 4. method overrides → 5. specName auto-tag → 6. workflow/tag overrides →
    // 7. runtime tags → 8. data output overrides
    const resolvedTags: Record<string, string> = {
      type: "file",
      ...(definitionTags ?? {}),
      ...(spec.tags ?? {}),
      ...(overrides?.tags ?? {}),
    };

    // Auto-inject specName tag for findBySpec discovery
    resolvedTags["specName"] = specName;

    // Auto-inject modelName tag for orphan data recovery (issue #370)
    if (definitionName) {
      resolvedTags["modelName"] = definitionName;
    }

    // Apply global tag overrides (workflow step tags)
    if (tagOverrides) {
      Object.assign(resolvedTags, tagOverrides);
    }

    // Apply runtime tags (--tag flags)
    if (runtimeTags) {
      Object.assign(resolvedTags, runtimeTags);
    }

    // Resolve options with overrides
    const contentType = overrides?.contentType ?? spec.contentType;
    let lifetime = overrides?.lifetime ?? spec.lifetime;
    let garbageCollection = overrides?.garbageCollection ??
      spec.garbageCollection;
    const streaming = overrides?.streaming ?? spec.streaming;

    // Apply data output overrides for this spec name
    if (dataOutputOverrides) {
      const override = dataOutputOverrides.find(
        (o) => o.specName === specName,
      );
      if (override) {
        lifetime = override.lifetime ?? lifetime;
        garbageCollection = override.garbageCollection ?? garbageCollection;
        if (override.tags) {
          Object.assign(resolvedTags, override.tags);
        }
      }
    }

    const resolvedOptions: ResolvedDataWriterOptions = {
      name: instanceName,
      specName,
      kind: "file",
      contentType,
      lifetime,
      garbageCollection,
      streaming,
      tags: resolvedTags,
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: modelId,
      },
    };

    const writer = new DefaultDataWriter(
      repo,
      modelType,
      modelId,
      resolvedOptions,
      callbacks,
    );
    writers.push(writer);

    // Wrap write methods to track handles
    const originalWriteAll = writer.writeAll.bind(writer);
    const originalWriteText = writer.writeText.bind(writer);
    const originalWriteStream = writer.writeStream.bind(writer);
    const originalFinalize = writer.finalize.bind(writer);

    writer.writeAll = async (content: Uint8Array) => {
      const handle = await originalWriteAll(content);
      handles.push(handle);
      return handle;
    };

    writer.writeText = async (text: string) => {
      const handle = await originalWriteText(text);
      handles.push(handle);
      return handle;
    };

    writer.writeStream = async (
      stream: ReadableStream<Uint8Array>,
      opts?: { onLine?: (line: string) => void },
    ) => {
      const handle = await originalWriteStream(stream, opts);
      handles.push(handle);
      return handle;
    };

    writer.finalize = async () => {
      const handle = await originalFinalize();
      handles.push(handle);
      return handle;
    };

    return writer;
  };

  return { createFileWriter, getHandles: () => [...handles] };
}
