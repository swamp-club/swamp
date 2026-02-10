import { Data } from "../data/mod.ts";
import type { DataId, OwnerDefinition } from "../data/mod.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { ModelType } from "./model_type.ts";
import {
  type DataHandle,
  type DataOutputSpecification,
  type DataWriter,
  type DataWriterCallbacks,
  type DataWriterFactory,
  normalizeSpecType,
  type ResolvedDataWriterOptions,
  type SpecBasedWriterOptions,
} from "./model.ts";
import type { DataSpecType } from "./model.ts";

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
  private readonly normalizedSpecType: DataSpecType;
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
    this.normalizedSpecType = normalizeSpecType(options.specType);
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
      definitionHash: "",
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
      specType: this.normalizedSpecType,
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
 * Creates a DataWriterFactory bound to a specific execution context.
 *
 * The factory resolves spec-based options against the model's declared
 * DataOutputSpecifications, merges workflow overrides, and produces
 * fully-resolved DefaultDataWriter instances.
 *
 * @param repo - The unified data repository
 * @param modelType - The model type
 * @param modelId - The model ID (definition ID)
 * @param definitionHash - The definition hash for ownership
 * @param dataOutputSpecs - The model's declared data output specifications
 * @param tagOverrides - Tags merged into every writer (e.g., workflow step tags)
 * @param dataOutputOverrides - Overrides merged into every writer's options
 * @param callbacks - Optional callbacks for streaming events
 * @returns A tuple of [factory, getHandles] where getHandles returns all completed handles
 */
export function createDataWriterFactory(
  repo: UnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
  definitionHash: string,
  dataOutputSpecs: Record<string, DataOutputSpecification>,
  tagOverrides?: Record<string, string>,
  dataOutputOverrides?: Array<{
    specType: string;
    lifetime?: string;
    garbageCollection?: string | number;
    tags?: Record<string, string>;
  }>,
  callbacks?: DataWriterCallbacks,
): { factory: DataWriterFactory; getHandles: () => DataHandle[] } {
  const handles: DataHandle[] = [];
  const writers: DefaultDataWriter[] = [];

  const factory: DataWriterFactory = (options: SpecBasedWriterOptions) => {
    // Look up the spec — fail fast if not declared
    const spec = dataOutputSpecs[options.specType];
    if (!spec) {
      const declared = Object.keys(dataOutputSpecs).join(", ");
      throw new Error(
        `Undeclared spec type '${options.specType}' in model '${modelType.normalized}'. ` +
          `Declared spec types: ${declared || "(none)"}`,
      );
    }

    // Resolve: spec defaults -> call-site overrides
    const resolvedTags = {
      ...spec.tags,
      ...(options.tags ?? {}),
    };

    let resolvedOptions: ResolvedDataWriterOptions = {
      name: options.name,
      specType: spec.specType,
      contentType: options.contentType ?? spec.contentType,
      lifetime: options.lifetime ?? spec.lifetime,
      garbageCollection: options.garbageCollection ?? spec.garbageCollection,
      streaming: options.streaming ?? spec.streaming,
      tags: resolvedTags,
    };

    // Apply workflow tag overrides
    if (tagOverrides) {
      resolvedOptions = {
        ...resolvedOptions,
        tags: {
          ...resolvedOptions.tags,
          ...tagOverrides,
        },
      };
    }

    // Apply data output overrides for this spec type
    if (dataOutputOverrides) {
      const normalizedSpec = normalizeSpecType(resolvedOptions.specType);
      const override = dataOutputOverrides.find(
        (o) => o.specType === normalizedSpec.value,
      );
      if (override) {
        resolvedOptions = {
          ...resolvedOptions,
          lifetime: override.lifetime ?? resolvedOptions.lifetime,
          garbageCollection: override.garbageCollection ??
            resolvedOptions.garbageCollection,
          tags: {
            ...resolvedOptions.tags,
            ...(override.tags ?? {}),
          },
        };
      }
    }

    // Set ownership from definitionHash
    resolvedOptions.ownerDefinition = {
      ownerType: "model-method",
      ownerRef: modelId,
      definitionHash,
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

  return { factory, getHandles: () => [...handles] };
}
