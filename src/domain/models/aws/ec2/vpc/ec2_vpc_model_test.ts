import { assertEquals, assertRejects } from "@std/assert";
import type { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import {
  EC2_VPC_MODEL_TYPE,
  EC2VpcInputAttributesSchema,
  ec2VpcModel,
  EC2VpcResourceAttributesSchema,
} from "./ec2_vpc_model.ts";
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
    modelType: EC2_VPC_MODEL_TYPE,
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

Deno.test("EC2VpcModel - model type", () => {
  assertEquals(ec2VpcModel.type.raw, "AWS::EC2::VPC");
  assertEquals(ec2VpcModel.type.normalized, "aws/ec2/vpc");
  assertEquals(ec2VpcModel.type, EC2_VPC_MODEL_TYPE);
});

Deno.test("EC2VpcModel - version", () => {
  assertEquals(ec2VpcModel.version, 1);
});

Deno.test("EC2VpcModel - has required methods", () => {
  assertEquals(Object.keys(ec2VpcModel.methods).sort(), [
    "create",
    "delete",
    "sync",
  ]);
});

Deno.test("EC2VpcModel - input schema validation with CidrBlock", () => {
  const validInput = {
    CidrBlock: "10.0.0.0/16",
  };

  const result = EC2VpcInputAttributesSchema.safeParse(validInput);
  assertEquals(result.success, true);
});

Deno.test("EC2VpcModel - input schema validation with IPAM pool", () => {
  const validInput = {
    Ipv4IpamPoolId: "ipam-pool-12345678",
    Ipv4NetmaskLength: 16,
  };

  const result = EC2VpcInputAttributesSchema.safeParse(validInput);
  assertEquals(result.success, true);
});

Deno.test("EC2VpcModel - input schema with all properties", () => {
  const fullInput = {
    CidrBlock: "10.0.0.0/16",
    EnableDnsHostnames: true,
    EnableDnsSupport: true,
    InstanceTenancy: "default" as const,
    Tags: [
      { Key: "Name", Value: "test-vpc" },
      { Key: "Environment", Value: "test" },
    ],
  };

  const result = EC2VpcInputAttributesSchema.safeParse(fullInput);
  assertEquals(result.success, true);
});

Deno.test("EC2VpcModel - input schema with dedicated tenancy", () => {
  const dedicatedInput = {
    CidrBlock: "10.0.0.0/16",
    InstanceTenancy: "dedicated" as const,
  };

  const result = EC2VpcInputAttributesSchema.safeParse(dedicatedInput);
  assertEquals(result.success, true);
});

Deno.test("EC2VpcModel - resource schema validation", () => {
  const validResource = {
    VpcId: "vpc-12345678",
    CidrBlock: "10.0.0.0/16",
    DefaultNetworkAcl: "acl-12345678",
    DefaultSecurityGroup: "sg-12345678",
    EnableDnsHostnames: true,
    EnableDnsSupport: true,
  };

  const result = EC2VpcResourceAttributesSchema.safeParse(validResource);
  assertEquals(result.success, true);
});

Deno.test("EC2VpcModel - resource schema with IPv6", () => {
  const validResource = {
    VpcId: "vpc-12345678",
    CidrBlock: "10.0.0.0/16",
    Ipv6CidrBlocks: ["2001:db8:1234:1a00::/56"],
    CidrBlockAssociations: ["vpc-cidr-assoc-12345678"],
  };

  const result = EC2VpcResourceAttributesSchema.safeParse(validResource);
  assertEquals(result.success, true);
});

Deno.test("EC2VpcModel - sync method without RequestToken fails", async () => {
  const definition = Definition.create({
    name: "test-vpc",
    attributes: {
      CidrBlock: "10.0.0.0/16",
    },
  });

  const context = createTestContext();

  await assertRejects(
    () => ec2VpcModel.methods.sync.execute(definition, context),
    Error,
    "AWS::EC2::VPC sync failed: no RequestToken found",
  );
});

Deno.test("EC2VpcModel - delete method without data returns deleted result", async () => {
  const definition = Definition.create({
    name: "test-vpc",
    attributes: {
      CidrBlock: "10.0.0.0/16",
    },
  });

  const context = createTestContext();

  const result = await ec2VpcModel.methods.delete.execute(definition, context);

  // Should return success data output since no data exists
  const attrs = getDataOutputAttributes(result.dataOutputs);
  assertEquals(attrs?.OperationStatus, "SUCCESS");
  assertEquals(attrs?.DeletionCompleted, true);
});

Deno.test("EC2VpcModel - create method uses injected CloudControl client", async () => {
  const definition = Definition.create({
    name: "test-vpc",
    attributes: {
      CidrBlock: "10.0.0.0/16",
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    },
  });

  const mockClient = {
    send: () =>
      Promise.resolve({
        ProgressEvent: {
          Identifier: "vpc-12345678",
          RequestToken: "request-123",
          OperationStatus: "IN_PROGRESS",
        },
      }),
  };

  const context = createTestContext({
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  });

  const result = await ec2VpcModel.methods.create.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs);
  assertEquals(attrs?.RequestToken, "request-123");
  assertEquals(attrs?.OperationStatus, "IN_PROGRESS");
  assertEquals(result.followUpActions?.length, 1);
  assertEquals(result.followUpActions?.[0].methodName, "sync");
});

Deno.test("EC2VpcModel - sync method treats 'not found' as deleted", async () => {
  const definition = Definition.create({
    name: "test-vpc",
    attributes: {
      RequestToken: "request-123",
      ResourceIdentifier: "vpc-12345678",
    },
  });

  const mockClient = {
    send: () =>
      Promise.resolve({
        ProgressEvent: {
          OperationStatus: "FAILED",
          StatusMessage:
            "Resource of type 'AWS::EC2::VPC' with identifier 'vpc-12345678' was not found.",
        },
      }),
  };

  const context = createTestContext({
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  });

  const result = await ec2VpcModel.methods.sync.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs);
  assertEquals(attrs?.OperationStatus, "SUCCESS");
  assertEquals(attrs?.DeletionCompleted, true);
  assertEquals(result.followUpActions, undefined);
});

Deno.test("EC2VpcModel - delete method treats 'not found' as success", async () => {
  const definition = Definition.create({
    name: "test-vpc",
    attributes: {
      CidrBlock: "10.0.0.0/16",
    },
  });

  // Mock data repository that returns existing data with VpcId
  const mockDataRepo = createMockDataRepo({
    VpcId: "vpc-12345678",
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
        "Resource of type 'AWS::EC2::VPC' with identifier 'vpc-12345678' was not found.",
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

  const result = await ec2VpcModel.methods.delete.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs);
  assertEquals(attrs?.OperationStatus, "SUCCESS");
  assertEquals(attrs?.DeletionCompleted, true);
  assertEquals(result.followUpActions, undefined);
});
