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
import type { MethodContext } from "../../../../models/model.ts";
import type { UnifiedDataRepository } from "../../../../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../../../definitions/repositories.ts";
import { generateDataId } from "../../../../data/data_id.ts";
import { getLogger } from "@logtape/logtape";

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
): MethodContext {
  return {
    repoDir: "/tmp/test-repo",
    modelType: EC2_INSTANCE_MODEL_TYPE,
    modelId: crypto.randomUUID(),
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
    ...overrides,
  };
}

/**
 * Helper to get attributes from a DataOutput.
 */
function getDataOutputAttributes(
  dataOutputs: { content: Uint8Array }[] | undefined,
  index = 0,
): Record<string, unknown> | undefined {
  if (!dataOutputs || dataOutputs.length <= index) {
    return undefined;
  }
  const content = new TextDecoder().decode(dataOutputs[index].content);
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

  const context = createTestContext();

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

  const context = createTestContext();

  const result = await ec2InstanceModel.methods.delete.execute(
    definition,
    context,
  );

  // Should return success data output since no data exists
  const attrs = getDataOutputAttributes(result.dataOutputs);
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

  const context = createTestContext({
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  });

  const result = await ec2InstanceModel.methods.create.execute(
    definition,
    context,
  );

  const attrs = getDataOutputAttributes(result.dataOutputs);
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

  const context = createTestContext({
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  });

  const result = await ec2InstanceModel.methods.sync.execute(
    definition,
    context,
  );

  // Should return success data output
  const attrs = getDataOutputAttributes(result.dataOutputs);
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

  const context = createTestContext({
    dataRepository: mockDataRepo,
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  });

  const result = await ec2InstanceModel.methods.delete.execute(
    definition,
    context,
  );

  // Should return success data output
  const attrs = getDataOutputAttributes(result.dataOutputs);
  assertEquals(attrs?.OperationStatus, "SUCCESS");
  assertEquals(attrs?.DeletionCompleted, true);
  assertEquals(result.followUpActions, undefined);
});
