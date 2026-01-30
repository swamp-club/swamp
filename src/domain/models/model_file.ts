import { z } from "zod";

/**
 * Branded type for ModelFile IDs.
 */
export type ModelFileId = string & { readonly _brand: unique symbol };

/**
 * Creates a ModelFileId from a string.
 */
export function createModelFileId(id: string): ModelFileId {
  return id as ModelFileId;
}

/**
 * Zod schema for the core properties of a ModelFile.
 */
export const ModelFileSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().nonnegative(),
  checksum: z.string().min(1),
});

/**
 * Type representing the data stored in a ModelFile.
 */
export type ModelFileData = z.infer<typeof ModelFileSchema>;

/**
 * Properties required to create a new ModelFile.
 */
export interface CreateModelFileProps {
  id?: string;
  version?: number;
  createdAt?: Date;
  filename: string;
  contentType: string;
  size: number;
  checksum: string;
}

/**
 * ModelFile is an entity representing file outputs (binaries, configs, generated code, etc.)
 *
 * Each file artifact has a unique ID (UUID), creation timestamp,
 * version, filename, MIME type, size, and checksum.
 */
export class ModelFile {
  private constructor(
    readonly id: ModelFileId,
    readonly version: number,
    readonly createdAt: Date,
    readonly filename: string,
    readonly contentType: string,
    readonly size: number,
    readonly checksum: string,
  ) {}

  /**
   * Creates a new ModelFile instance.
   *
   * @param props - Properties for the new file artifact
   * @returns A new ModelFile instance
   */
  static create(props: CreateModelFileProps): ModelFile {
    const id = props.id ?? crypto.randomUUID();
    const version = props.version ?? 1;
    const createdAt = props.createdAt ?? new Date();

    const validated = ModelFileSchema.parse({
      id,
      version,
      createdAt: createdAt.toISOString(),
      filename: props.filename,
      contentType: props.contentType,
      size: props.size,
      checksum: props.checksum,
    });

    return new ModelFile(
      createModelFileId(validated.id),
      validated.version,
      new Date(validated.createdAt),
      validated.filename,
      validated.contentType,
      validated.size,
      validated.checksum,
    );
  }

  /**
   * Reconstructs a ModelFile from persisted data.
   *
   * @param data - The persisted data
   * @returns A ModelFile instance
   */
  static fromData(data: ModelFileData): ModelFile {
    const validated = ModelFileSchema.parse(data);
    return new ModelFile(
      createModelFileId(validated.id),
      validated.version,
      new Date(validated.createdAt),
      validated.filename,
      validated.contentType,
      validated.size,
      validated.checksum,
    );
  }

  /**
   * Converts the file artifact to a plain data object for persistence.
   */
  toData(): ModelFileData {
    return {
      id: this.id,
      version: this.version,
      createdAt: this.createdAt.toISOString(),
      filename: this.filename,
      contentType: this.contentType,
      size: this.size,
      checksum: this.checksum,
    };
  }

  /**
   * Gets the file extension from the filename.
   */
  get extension(): string {
    const lastDot = this.filename.lastIndexOf(".");
    return lastDot >= 0 ? this.filename.slice(lastDot + 1) : "";
  }
}

/**
 * Computes SHA-256 checksum of content.
 *
 * @param content - The content to hash
 * @returns The hex-encoded SHA-256 checksum
 */
export async function computeChecksum(content: Uint8Array): Promise<string> {
  // Create a new ArrayBuffer from the Uint8Array to avoid SharedArrayBuffer issues
  const buffer = new ArrayBuffer(content.length);
  new Uint8Array(buffer).set(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
