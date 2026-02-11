import { z } from "zod";
import { ModelType } from "../../model_type.ts";
import { computeChecksum } from "../../checksum.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
} from "../../model.ts";

/**
 * Schema for curl model input attributes.
 */
export const CurlInputAttributesSchema = z.object({
  /** URL to download */
  url: z.string().url(),
  /** HTTP method (default: GET) */
  method: z.enum(["GET", "HEAD", "POST", "PUT", "DELETE"]).default("GET"),
  /** Optional HTTP headers */
  headers: z.record(z.string(), z.string()).optional(),
  /** Optional filename for the downloaded file (defaults to URL basename) */
  outputFilename: z.string()
    .refine(
      (name) =>
        !name.includes("/") && !name.includes("\\") && !name.includes(".."),
      { message: "Filename cannot contain path separators or '..' sequences" },
    )
    .optional(),
  /** Whether to follow redirects (default: true) */
  followRedirects: z.boolean().default(true),
  /** Request timeout in milliseconds */
  timeout: z.number().int().positive().optional(),
});

/**
 * Type for curl model input attributes.
 */
export type CurlInputAttributes = z.infer<typeof CurlInputAttributesSchema>;

/**
 * Schema for curl model resource attributes.
 */
export const CurlResourceAttributesSchema = z.object({
  /** The URL that was downloaded */
  url: z.string().url(),
  /** HTTP status code */
  statusCode: z.number().int(),
  /** Content-Type header from the response */
  contentType: z.string(),
  /** Content-Length from response (or actual size) */
  contentLength: z.number().int().nonnegative(),
  /** Timestamp when download completed */
  downloadedAt: z.string().datetime(),
  /** Duration of the download in milliseconds */
  durationMs: z.number().int().nonnegative(),
  /** Reference to the file artifact containing the downloaded content */
  fileId: z.string().uuid(),
});

/**
 * Type for curl model resource attributes.
 */
export type CurlResourceAttributes = z.infer<
  typeof CurlResourceAttributesSchema
>;

/**
 * The curl model type identifier.
 */
export const CURL_MODEL_TYPE = ModelType.create("command/curl");

/**
 * Extracts filename from URL or Content-Disposition header.
 */
function extractFilename(url: string, headers: Headers): string {
  // Check Content-Disposition header first
  const disposition = headers.get("content-disposition");
  if (disposition) {
    const match = disposition.match(/filename[*]?=['"]?([^'"\s;]+)['"]?/i);
    if (match) {
      return match[1];
    }
  }

  // Fall back to URL path
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const basename = pathname.split("/").pop();
    if (basename && basename.length > 0) {
      return basename;
    }
  } catch {
    // URL parsing failed
  }

  // Default filename
  return "download";
}

/**
 * Executes the "download" method for the curl model.
 *
 * Downloads the URL and returns both metadata and file content as data outputs.
 */
async function executeDownload(
  args: CurlInputAttributes,
  context: MethodContext,
): Promise<MethodResult> {
  const startTime = Date.now();

  // Build fetch options
  const fetchOptions: RequestInit = {
    method: args.method,
    redirect: args.followRedirects ? "follow" : "manual",
  };

  // Add headers if provided
  if (args.headers) {
    fetchOptions.headers = new Headers(
      Object.entries(args.headers) as [string, string][],
    );
  }

  // Add timeout via AbortController if specified
  let abortController: AbortController | undefined;
  if (args.timeout) {
    abortController = new AbortController();
    fetchOptions.signal = abortController.signal;
    setTimeout(() => abortController?.abort(), args.timeout);
  }

  // Perform the fetch
  const response = await fetch(args.url, fetchOptions);

  if (!response.ok) {
    // Consume the response body to avoid resource leak
    await response.body?.cancel();
    throw new Error(
      `HTTP request failed: ${response.status} ${response.statusText}`,
    );
  }

  // Read the response body
  const content = new Uint8Array(await response.arrayBuffer());
  const endTime = Date.now();
  const durationMs = endTime - startTime;

  // Determine filename
  const filename = args.outputFilename ??
    extractFilename(args.url, response.headers);

  // Get content type
  const contentType = response.headers.get("content-type") ??
    "application/octet-stream";

  // Compute checksum
  const checksum = await computeChecksum(content);

  // Create metadata attributes
  const metadataAttributes = {
    url: args.url,
    statusCode: response.status,
    contentType,
    contentLength: content.length,
    downloadedAt: new Date().toISOString(),
    durationMs,
    filename,
    checksum,
  };

  const metadataHandle = await context.writeResource!(
    "metadata",
    "metadata",
    metadataAttributes,
  );

  const fileWriter = context.createFileWriter!("content", "content", {
    contentType,
  });
  const fileHandle = await fileWriter.writeAll(content);

  return { dataHandles: [metadataHandle, fileHandle] };
}

/**
 * The curl model definition.
 *
 * A model that downloads files via HTTP and stores them as data artifacts.
 * Returns both metadata (URL, status, timing) and the actual file content.
 *
 * Self-registers with the global model registry when this module is imported.
 */
export const curlModel = defineModel({
  type: CURL_MODEL_TYPE,
  version: "2026.02.09.1",
  globalArguments: CurlInputAttributesSchema,
  resources: {
    "metadata": {
      description: "Download metadata (URL, status, timing, checksum)",
      schema: CurlResourceAttributesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    "content": {
      description: "Downloaded file content",
      contentType: "application/octet-stream",
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    download: {
      description:
        "Download a file from the URL and store it as a data artifact",
      arguments: CurlInputAttributesSchema,
      execute: executeDownload,
    },
  },
});
