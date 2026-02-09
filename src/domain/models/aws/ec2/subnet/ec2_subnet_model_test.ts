import { assertEquals, assertRejects } from "@std/assert";
import type { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import {
  EC2_SUBNET_MODEL_TYPE,
  EC2SubnetInputAttributesSchema,
  ec2SubnetModel,
  EC2SubnetResourceAttributesSchema,
} from "./ec2_subnet_model.ts";
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
    modelType: EC2_SUBNET_MODEL_TYPE,
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

Deno.test("EC2SubnetModel - model type", () => {
  assertEquals(ec2SubnetModel.type.raw, "AWS::EC2::Subnet");
  assertEquals(ec2SubnetModel.type.normalized, "aws/ec2/subnet");
  assertEquals(ec2SubnetModel.type, EC2_SUBNET_MODEL_TYPE);
});

Deno.test("EC2SubnetModel - version", () => {
  assertEquals(ec2SubnetModel.version, 1);
});

Deno.test("EC2SubnetModel - has required methods", () => {
  assertEquals(Object.keys(ec2SubnetModel.methods).sort(), [
    "create",
    "delete",
    "sync",
  ]);
});

Deno.test("EC2SubnetModel - input schema validation minimal", () => {
  const validInput = {
    VpcId: "vpc-12345678",
    CidrBlock: "10.0.1.0/24",
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(validInput);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - input schema requires VpcId", () => {
  const invalidInput = {
    CidrBlock: "10.0.1.0/24",
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(invalidInput);
  assertEquals(result.success, false);
});

Deno.test("EC2SubnetModel - input schema with availability zone", () => {
  const validInput = {
    VpcId: "vpc-12345678",
    CidrBlock: "10.0.1.0/24",
    AvailabilityZone: "us-east-1a",
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(validInput);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - input schema with AZ ID", () => {
  const validInput = {
    VpcId: "vpc-12345678",
    CidrBlock: "10.0.1.0/24",
    AvailabilityZoneId: "use1-az1",
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(validInput);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - input schema with all properties", () => {
  const fullInput = {
    VpcId: "vpc-12345678",
    CidrBlock: "10.0.1.0/24",
    AvailabilityZone: "us-east-1a",
    AssignIpv6AddressOnCreation: false,
    MapPublicIpOnLaunch: true,
    EnableDns64: false,
    Ipv6Native: false,
    EnableLniAtDeviceIndex: 1,
    PrivateDnsNameOptionsOnLaunch: {
      EnableResourceNameDnsAAAARecord: false,
      EnableResourceNameDnsARecord: true,
      HostnameType: "ip-name" as const,
    },
    Tags: [
      { Key: "Name", Value: "test-subnet" },
      { Key: "Environment", Value: "test" },
    ],
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(fullInput);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - input schema with IPv6", () => {
  const ipv6Input = {
    VpcId: "vpc-12345678",
    Ipv6CidrBlock: "2001:db8:1234:1a00::/64",
    Ipv6Native: true,
    AssignIpv6AddressOnCreation: true,
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(ipv6Input);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - input schema with IPAM", () => {
  const ipamInput = {
    VpcId: "vpc-12345678",
    Ipv4IpamPoolId: "ipam-pool-12345678",
    Ipv4NetmaskLength: 24,
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(ipamInput);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - input schema with Outpost", () => {
  const outpostInput = {
    VpcId: "vpc-12345678",
    CidrBlock: "10.0.1.0/24",
    OutpostArn: "arn:aws:outposts:us-east-1:123456789012:outpost/op-12345678",
  };

  const result = EC2SubnetInputAttributesSchema.safeParse(outpostInput);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - resource schema validation", () => {
  const validResource = {
    SubnetId: "subnet-12345678",
    VpcId: "vpc-12345678",
    AvailabilityZone: "us-east-1a",
    CidrBlock: "10.0.1.0/24",
    MapPublicIpOnLaunch: true,
  };

  const result = EC2SubnetResourceAttributesSchema.safeParse(validResource);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - resource schema with all attributes", () => {
  const fullResource = {
    SubnetId: "subnet-12345678",
    VpcId: "vpc-12345678",
    AvailabilityZone: "us-east-1a",
    AvailabilityZoneId: "use1-az1",
    CidrBlock: "10.0.1.0/24",
    Ipv6CidrBlocks: ["2001:db8:1234:1a00::/64"],
    NetworkAclAssociationId: "aclassoc-12345678",
    MapPublicIpOnLaunch: true,
    AssignIpv6AddressOnCreation: false,
    Ipv6Native: false,
    EnableDns64: false,
    Tags: [
      { Key: "Name", Value: "test-subnet" },
    ],
  };

  const result = EC2SubnetResourceAttributesSchema.safeParse(fullResource);
  assertEquals(result.success, true);
});

Deno.test("EC2SubnetModel - sync method without RequestToken fails", async () => {
  const definition = Definition.create({
    name: "test-subnet",
    attributes: {
      VpcId: "vpc-12345678",
      CidrBlock: "10.0.1.0/24",
    },
  });

  const context = createTestContext();

  await assertRejects(
    () => ec2SubnetModel.methods.sync.execute(definition, context),
    Error,
    "AWS::EC2::Subnet sync failed: no RequestToken found",
  );
});

Deno.test("EC2SubnetModel - delete method without data returns deleted result", async () => {
  const definition = Definition.create({
    name: "test-subnet",
    attributes: {
      VpcId: "vpc-12345678",
      CidrBlock: "10.0.1.0/24",
    },
  });

  const context = createTestContext();

  const result = await ec2SubnetModel.methods.delete.execute(
    definition,
    context,
  );

  // Should return success data output since no data exists
  const attrs = getDataOutputAttributes(result.dataOutputs);
  assertEquals(attrs?.OperationStatus, "SUCCESS");
  assertEquals(attrs?.DeletionCompleted, true);
});

Deno.test("EC2SubnetModel - create method uses injected CloudControl client", async () => {
  const definition = Definition.create({
    name: "test-subnet",
    attributes: {
      VpcId: "vpc-12345678",
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: "us-east-1a",
    },
  });

  const mockClient = {
    send: () =>
      Promise.resolve({
        ProgressEvent: {
          Identifier: "subnet-12345678",
          RequestToken: "request-123",
          OperationStatus: "IN_PROGRESS",
        },
      }),
  };

  const context = createTestContext({
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  });

  const result = await ec2SubnetModel.methods.create.execute(
    definition,
    context,
  );

  const attrs = getDataOutputAttributes(result.dataOutputs);
  assertEquals(attrs?.RequestToken, "request-123");
  assertEquals(attrs?.OperationStatus, "IN_PROGRESS");
  assertEquals(result.followUpActions?.length, 1);
  assertEquals(result.followUpActions?.[0].methodName, "sync");
});

Deno.test("EC2SubnetModel - sync method treats 'not found' as deleted", async () => {
  const definition = Definition.create({
    name: "test-subnet",
    attributes: {
      RequestToken: "request-123",
      ResourceIdentifier: "subnet-12345678",
    },
  });

  const mockClient = {
    send: () =>
      Promise.resolve({
        ProgressEvent: {
          OperationStatus: "FAILED",
          StatusMessage:
            "Resource of type 'AWS::EC2::Subnet' with identifier 'subnet-12345678' was not found.",
        },
      }),
  };

  const context = createTestContext({
    cloudControlClientFactory: () =>
      mockClient as unknown as CloudControlClient,
  });

  const result = await ec2SubnetModel.methods.sync.execute(definition, context);

  const attrs = getDataOutputAttributes(result.dataOutputs);
  assertEquals(attrs?.OperationStatus, "SUCCESS");
  assertEquals(attrs?.DeletionCompleted, true);
  assertEquals(result.followUpActions, undefined);
});

Deno.test("EC2SubnetModel - delete method treats 'not found' as success", async () => {
  const definition = Definition.create({
    name: "test-subnet",
    attributes: {
      VpcId: "vpc-12345678",
      CidrBlock: "10.0.1.0/24",
    },
  });

  // Mock data repository that returns existing data with SubnetId
  const mockDataRepo = createMockDataRepo({
    SubnetId: "subnet-12345678",
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
        "Resource of type 'AWS::EC2::Subnet' with identifier 'subnet-12345678' was not found.",
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

  const result = await ec2SubnetModel.methods.delete.execute(
    definition,
    context,
  );

  const attrs = getDataOutputAttributes(result.dataOutputs);
  assertEquals(attrs?.OperationStatus, "SUCCESS");
  assertEquals(attrs?.DeletionCompleted, true);
  assertEquals(result.followUpActions, undefined);
});
