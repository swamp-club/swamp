import { assertEquals, assertRejects } from "@std/assert";
import type { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import {
  EC2_INSTANCE_MODEL_TYPE,
  EC2InstanceInputAttributesSchema,
  ec2InstanceModel,
  EC2InstanceResourceAttributesSchema,
} from "./ec2_instance_model.ts";
import {
  createDefinitionId,
  Definition,
} from "../../../../definitions/definition.ts";
import { normalizeSpecType } from "../../../../models/model.ts";
import type {
  DataHandle,
  DataWriter,
  DataWriterFactory,
  MethodContext,
  SpecBasedWriterOptions,
} from "../../../../models/model.ts";
import type { UnifiedDataRepository } from "../../../../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../../../definitions/repositories.ts";
import { type DataId, generateDataId } from "../../../../data/data_id.ts";
import { getLogger } from "@logtape/logtape";

/**
 * Stored result from mock data writer.
 */
interface MockWriterResult {
  handle: DataHandle;
  content: Uint8Array;
}

/**
 * Creates a mock DataWriterFactory that stores written content in memory.
 */
function createMockDataWriterFactory(): {
  factory: DataWriterFactory;
  getResults: () => MockWriterResult[];
} {
  const results: MockWriterResult[] = [];
  const getResults = (): MockWriterResult[] => results;
  let nextId = 1;

  const factory: DataWriterFactory = (
    options: SpecBasedWriterOptions,
  ): DataWriter => {
    const dataId = `mock-data-${nextId++}` as DataId;

    const buildHandle = (content: Uint8Array): DataHandle => ({
      name: options.name,
      specType: normalizeSpecType(options.specType),
      dataId,
      version: 1,
      size: content.length,
      tags: options.tags ?? {},
      metadata: {
        contentType: options.contentType ?? "application/json",
        lifetime: options.lifetime ?? "infinite",
        garbageCollection: options.garbageCollection ?? 10,
        streaming: options.streaming ?? false,
        tags: options.tags ?? {},
        ownerDefinition: {
          definitionHash: "test-hash",
          ownerType: "model-method",
          ownerRef: "test",
        },
      },
    });

    return {
      dataId,
      name: options.name,
      writeAll(content: Uint8Array): Promise<DataHandle> {
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      writeText(text: string): Promise<DataHandle> {
        const content = new TextEncoder().encode(text);
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      writeLine(_line: string): Promise<void> {
        return Promise.resolve();
      },
      writeStream(
        _stream: ReadableStream<Uint8Array>,
      ): Promise<DataHandle> {
        const content = new Uint8Array();
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
      getFilePath(): Promise<string> {
        return Promise.resolve("/tmp/mock");
      },
      finalize(): Promise<DataHandle> {
        const content = new Uint8Array();
        const handle = buildHandle(content);
        results.push({ handle, content });
        return Promise.resolve(handle);
      },
    } as DataWriter;
  };

  return { factory, getResults };
}

/**
 * Creates a mock UnifiedDataRepository for testing.
 */
function createMockDataRepo(
  findByNameResult: Record<string, unknown> | null = null,
): UnifiedDataRepository {
  return {
    findByName: () => Promise.resolve(findByNameResult as unknown as null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: findByNameResult
      ? () =>
        Promise.resolve(
          new TextEncoder().encode(JSON.stringify(findByNameResult)),
        )
      : () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    removeLatestSymlink: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: () =>
      Promise.resolve({ version: 1, contentPath: "/tmp/mock" }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
  };
}

/**
 * Creates a mock DefinitionRepository for testing.
 */
function createMockDefinitionRepo(): DefinitionRepository {
  return {
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findByNameGlobal: () => Promise.resolve(null),
    findAllGlobal: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => createDefinitionId(crypto.randomUUID()),
    getPath: () => "",
  };
}

/**
 * Creates a test MethodContext with mocked repositories.
 */
function createTestContext(
  overrides?: Partial<MethodContext>,
): { context: MethodContext; getResults: () => MockWriterResult[] } {
  const { factory, getResults } = createMockDataWriterFactory();
  const context: MethodContext = {
    repoDir: "/tmp/test-repo",
    modelType: EC2_INSTANCE_MODEL_TYPE,
    modelId: crypto.randomUUID(),
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    createDataWriter: factory,
    ...overrides,
  };
  return { context, getResults };
}

/**
 * Helper to get attributes from mock writer results.
 */
function getDataHandleAttributes(
  results: MockWriterResult[],
  index = 0,
): Record<string, unknown> | undefined {
  if (results.length <= index) {
    return undefined;
  }
  const content = new TextDecoder().decode(results[index].content);
  const parsed = JSON.parse(content);
  // CloudControl resources wrap in {attributes: {...}}
  return parsed.attributes ?? parsed;
}

Deno.test("EC2InstanceModel - model type", () => {
  assertEquals(ec2InstanceModel.type.raw, "AWS::EC2::Instance");
  assertEquals(ec2InstanceModel.type.normalized, "aws/ec2/instance");
  assertEquals(ec2InstanceModel.type, EC2_INSTANCE_MODEL_TYPE);
});

Deno.test("EC2InstanceModel - version", () => {
  assertEquals(ec2InstanceModel.version, "2026.02.09.1");
});

Deno.test("EC2InstanceModel - has required methods", () => {
  assertEquals(Object.keys(ec2InstanceModel.methods).sort(), [
    "create",
    "delete",
    "sync",
  ]);
});

Deno.test("EC2InstanceModel - input schema validation", () => {
  // Valid minimal input
  const validInput = {
    ImageId: "ami-12345678",
    InstanceType: "t2.micro",
  };

  const result = EC2InstanceInputAttributesSchema.safeParse(validInput);
  assertEquals(result.success, true);
});

Deno.test("EC2InstanceModel - input schema with all properties", () => {
  const fullInput = {
    AdditionalInfo: "test-info",
    Affinity: "default" as const,
    AvailabilityZone: "us-east-1a",
    BlockDeviceMappings: [{
      DeviceName: "/dev/sda1",
      Ebs: {
        VolumeSize: 20,
        VolumeType: "gp3" as const,
        DeleteOnTermination: true,
      },
    }],
    CpuOptions: {
      CoreCount: 1,
      ThreadsPerCore: 2,
    },
    CreditSpecification: {
      CpuCredits: "standard" as const,
    },
    DisableApiTermination: false,
    EbsOptimized: true,
    ImageId: "ami-12345678",
    InstanceType: "t2.micro",
    KeyName: "my-key",
    MetadataOptions: {
      HttpEndpoint: "enabled" as const,
      HttpTokens: "required" as const,
    },
    Monitoring: true,
    SecurityGroupIds: ["sg-12345678"],
    SubnetId: "subnet-12345678",
    Tags: [
      { Key: "Name", Value: "test-instance" },
      { Key: "Environment", Value: "test" },
    ],
    UserData: "IyEvYmluL2Jhc2gK", // base64 encoded
  };

  const result = EC2InstanceInputAttributesSchema.safeParse(fullInput);
  assertEquals(result.success, true);
});

Deno.test("EC2InstanceModel - resource schema validation", () => {
  const validResource = {
    InstanceId: "i-1234567890abcdef0",
    State: {
      Code: 16,
      Name: "running",
    },
    PrivateIpAddress: "10.0.1.100",
    PublicIpAddress: "54.123.45.67",
  };

  const result = EC2InstanceResourceAttributesSchema.safeParse(validResource);
  assertEquals(result.success, true);
});

Deno.test("EC2InstanceModel - sync method without RequestToken fails", async () => {
  const definition = Definition.create({
    name: "test-instance",
    attributes: {
      ImageId: "ami-12345678",
      InstanceType: "t2.micro",
    },
  });

  const { context } = createTestContext();

  await assertRejects(
    () => ec2InstanceModel.methods.sync.execute(definition, context),
    Error,
    "AWS::EC2::Instance sync failed: no RequestToken found",
  );
});

Deno.test("EC2InstanceModel - delete method without data returns deleted result", async () => {
  const definition = Definition.create({
    name: "test-instance",
    attributes: {
      ImageId: "ami-12345678",
      InstanceType: "t2.micro",
    },
  });

  const { context, getResults } = createTestContext();

  await ec2InstanceModel.methods.delete.execute(
    definition,
    context,
  );

  // Should return success data handle since no data exists
  const attrs = getDataHandleAttributes(getResults());
  assertEquals(attrs?.OperationStatus, "SUCCESS");
  assertEquals(attrs?.DeletionCompleted, true);
});

Deno.test("EC2InstanceModel - create method uses injected CloudControl client", async () => {
  const definition = Definition.create({
    name: "test-instance",
    attributes: {
      ImageId: "ami-12345678",
      InstanceType: "t2.micro",
    },
  });

  // Mock CloudControl client that returns success
  const mockClient = {
    send: () =>
      Promise.resolve({
        ProgressEvent: {
          Identifier: "i-1234567890abcdef0",
          RequestToken: "request-123",
          OperationStatus: "IN_PROGRESS",
        },
      }),
  };

  const { context, getResults } = createTestContext({
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  });

  const result = await ec2InstanceModel.methods.create.execute(
    definition,
    context,
  );

  const attrs = getDataHandleAttributes(getResults());
  assertEquals(attrs?.RequestToken, "request-123");
  assertEquals(attrs?.OperationStatus, "IN_PROGRESS");
  assertEquals(result.followUpActions?.length, 1);
  assertEquals(result.followUpActions?.[0].methodName, "sync");
});

Deno.test("EC2InstanceModel - sync method treats 'not found' as deleted", async () => {
  const definition = Definition.create({
    name: "test-instance",
    attributes: {
      RequestToken: "request-123",
      ResourceIdentifier: "i-1234567890abcdef0",
    },
  });

  // Mock CloudControl client where status check returns FAILED with "not found"
  const mockClient = {
    send: () =>
      Promise.resolve({
        ProgressEvent: {
          OperationStatus: "FAILED",
          StatusMessage:
            "Resource of type 'AWS::EC2::Instance' with identifier 'i-1234567890abcdef0' was not found.",
        },
      }),
  };

  const { context, getResults } = createTestContext({
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  });

  const result = await ec2InstanceModel.methods.sync.execute(
    definition,
    context,
  );

  // Should return success data handle
  const attrs = getDataHandleAttributes(getResults());
  assertEquals(attrs?.OperationStatus, "SUCCESS");
  assertEquals(attrs?.DeletionCompleted, true);
  assertEquals(result.followUpActions, undefined);
});

Deno.test("EC2InstanceModel - delete method treats 'not found' as success", async () => {
  const definition = Definition.create({
    name: "test-instance",
    attributes: {
      ImageId: "ami-12345678",
      InstanceType: "t2.micro",
    },
  });

  // Mock data repository that returns existing data with InstanceId
  const mockDataRepo = createMockDataRepo({
    InstanceId: "i-1234567890abcdef0",
  });

  // Need to mock findByName to return non-null to trigger the delete path
  (mockDataRepo as unknown as { findByName: () => Promise<unknown> })
    .findByName = () =>
      Promise.resolve({
        id: "test-id",
        name: "test-data",
        version: 1,
      });

  // Mock CloudControl client that returns "not found" error
  const mockClient = {
    send: () => {
      const error = new Error(
        "Resource of type 'AWS::EC2::Instance' with identifier 'i-1234567890abcdef0' was not found.",
      );
      error.name = "ResourceNotFoundException";
      return Promise.reject(error);
    },
  };

  const { context, getResults } = createTestContext({
    dataRepository: mockDataRepo,
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  });

  const result = await ec2InstanceModel.methods.delete.execute(
    definition,
    context,
  );

  // Should return success data handle
  const attrs = getDataHandleAttributes(getResults());
  assertEquals(attrs?.OperationStatus, "SUCCESS");
  assertEquals(attrs?.DeletionCompleted, true);
  assertEquals(result.followUpActions, undefined);
});
