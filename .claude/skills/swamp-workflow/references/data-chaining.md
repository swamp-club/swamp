# Data Chaining in Workflows

The `aws/cli` model enables powerful data chaining in workflows by running AWS
CLI commands and making the output available to other models. This is useful for
dynamic lookups like finding the latest AMI, checking resource state, or
querying AWS for configuration values.

## Implicit Dependency Resolution

When a model input contains an expression like
`${{ model.<name>.resource.<specName>.<instanceName>.attributes.<field> }}`, the
workflow engine automatically:

1. Detects the dependency on the referenced model
2. Ensures the referenced model's method runs first
3. Evaluates expressions just-in-time before each step executes

## Example: Dynamic AMI Lookup Workflow

```yaml
id: ec2-with-latest-ami
name: ec2-with-latest-ami
description: Create EC2 instance with dynamically looked-up AMI
version: 1
jobs:
  - name: provision
    description: Provision EC2 with latest Amazon Linux AMI
    steps:
      - name: lookup-ami
        description: Find latest Amazon Linux 2 AMI
        task:
          type: model_method
          modelIdOrName: latest-ami
          methodName: run
      - name: create-instance
        description: Create EC2 instance using looked-up AMI
        task:
          type: model_method
          modelIdOrName: my-instance
          methodName: create
```

### Model Inputs

```yaml
# latest-ami input (aws/cli model)
name: latest-ami
attributes:
  command: >-
    ec2 describe-images --owners amazon
    --filters "Name=name,Values=amzn2-ami-hvm-*-x86_64-gp2"
    --query "sort_by(Images,&CreationDate)[-1]"
  region: us-east-1
  parseJson: true
```

```yaml
# my-instance input (references aws/cli output)
name: my-instance
attributes:
  imageId: ${{ model.latest-ami.resource.data.data.attributes.json.ImageId }}
  instanceType: t3.micro
```

The workflow engine detects that `my-instance` references
`latest-ami.resource.data.data.attributes`, creating an implicit dependency.

## Example: Multi-Step Infrastructure Workflow

```yaml
id: full-stack-provision
name: full-stack-provision
description: Provision complete infrastructure with dynamic lookups
version: 1
jobs:
  - name: lookup
    description: Look up existing infrastructure
    steps:
      - name: find-vpc
        task:
          type: model_method
          modelIdOrName: vpc-lookup
          methodName: run
      - name: find-subnet
        task:
          type: model_method
          modelIdOrName: subnet-lookup
          methodName: run
  - name: provision
    description: Create resources using lookup results
    dependsOn:
      - job: lookup
        condition:
          type: succeeded
    steps:
      - name: create-security-group
        task:
          type: model_method
          modelIdOrName: app-security-group
          methodName: create
      - name: create-instance
        task:
          type: model_method
          modelIdOrName: app-server
          methodName: create
```

### Model Inputs for Multi-Step Workflow

```yaml
# vpc-lookup (aws/cli)
name: vpc-lookup
attributes:
  command: ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query "Vpcs[0]"
  parseJson: true
```

```yaml
# subnet-lookup (aws/cli) - chains from vpc-lookup
name: subnet-lookup
attributes:
  command: >-
    ec2 describe-subnets
    --filters "Name=vpc-id,Values=${{ model.vpc-lookup.resource.data.data.attributes.json.VpcId }}"
    --query "Subnets[0]"
  parseJson: true
```

```yaml
# app-security-group - chains from vpc-lookup
name: app-security-group
attributes:
  vpcId: ${{ model.vpc-lookup.resource.data.data.attributes.json.VpcId }}
  groupName: app-sg
  description: Security group for application
```

```yaml
# app-server - chains from multiple lookups
name: app-server
attributes:
  imageId: ${{ model.latest-ami.resource.data.data.attributes.json.ImageId }}
  subnetId: ${{ model.subnet-lookup.resource.data.data.attributes.json.SubnetId }}
  securityGroupIds:
    - ${{ model.app-security-group.resource.resource.resource.attributes.groupId }}
  instanceType: t3.micro
```

## Resource References

All model data outputs are accessed via
`model.<name>.resource.<specName>.<instanceName>.attributes.<field>`:

| Model Type    | Spec Name  | Example                                                       |
| ------------- | ---------- | ------------------------------------------------------------- |
| aws/cli       | `data`     | `model.ami-lookup.resource.data.data.attributes.json.ImageId` |
| Cloud Control | `resource` | `model.my-vpc.resource.resource.resource.attributes.VpcId`    |
| Custom models | (varies)   | `model.my-deploy.resource.state.state.attributes.endpoint`    |
