# Data Chaining with aws/cli Model

The `aws/cli` model enables data chaining by running AWS CLI commands and
capturing output for use in other models. Use `parseJson: true` to parse JSON
output and access it via `data.attributes.json`.

## aws/cli Data Attributes

| Attribute    | Description                                   |
| ------------ | --------------------------------------------- |
| `output`     | Raw stdout from the command                   |
| `json`       | Parsed JSON output (when `parseJson: true`)   |
| `exitCode`   | Command exit code                             |
| `executedAt` | ISO timestamp when command was executed       |
| `durationMs` | Duration of command execution in milliseconds |

## Example: Dynamic AMI Lookup

**Step 1: Create an aws/cli model to look up an AMI:**

```yaml
# .data/inputs/aws/cli/<uuid>.yaml
id: 550e8400-e29b-41d4-a716-446655440002
name: latest-ami
version: 1
tags: {}
attributes:
  command: >-
    ec2 describe-images --owners amazon
    --filters "Name=name,Values=amzn2-ami-hvm-*-x86_64-gp2"
    --query "sort_by(Images,&CreationDate)[-1]"
  region: us-east-1
  parseJson: true
```

**Step 2: Reference the CLI output in another model:**

```yaml
# .data/inputs/myorg/ec2-instance/<uuid>.yaml
id: 550e8400-e29b-41d4-a716-446655440003
name: my-instance
version: 1
tags: {}
attributes:
  # Reference parsed JSON fields from the aws/cli model's data output
  imageId: ${{ model.latest-ami.data.attributes.json.ImageId }}
  instanceType: t3.micro
  tags:
    Name: ${{ self.name }}
    AmiName: ${{ model.latest-ami.data.attributes.json.Name }}
```

## Example: Security Group Lookup

```yaml
# Look up default VPC security group
name: default-sg
attributes:
  command: >-
    ec2 describe-security-groups
    --filters "Name=group-name,Values=default"
    --query "SecurityGroups[0]"
  parseJson: true
```

```yaml
# Reference in EC2 instance
name: my-server
attributes:
  securityGroupIds:
    - ${{ model.default-sg.data.attributes.json.GroupId }}
```

## Example: Chaining Multiple Lookups

```yaml
# Step 1: Get VPC ID
name: vpc-lookup
attributes:
  command: ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query "Vpcs[0]"
  parseJson: true
```

```yaml
# Step 2: Get subnet in that VPC
name: subnet-lookup
attributes:
  command: >-
    ec2 describe-subnets
    --filters "Name=vpc-id,Values=${{ model.vpc-lookup.data.attributes.json.VpcId }}"
    --query "Subnets[0]"
  parseJson: true
```

```yaml
# Step 3: Use both in instance creation
name: my-instance
attributes:
  subnetId: ${{ model.subnet-lookup.data.attributes.json.SubnetId }}
  vpcId: ${{ model.vpc-lookup.data.attributes.json.VpcId }}
```
