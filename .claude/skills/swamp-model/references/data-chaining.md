# Data Chaining with command/shell Model

The `command/shell` model enables data chaining by running shell commands and
capturing output for use in other models. For JSON output, use `jq` in the
command to extract specific fields, then access the result via
`resource.result.result.attributes.stdout`.

## command/shell Data Attributes

| Attribute    | Description                                   |
| ------------ | --------------------------------------------- |
| `stdout`     | Raw stdout from the command                   |
| `stderr`     | Raw stderr from the command                   |
| `exitCode`   | Command exit code                             |
| `executedAt` | ISO timestamp when command was executed       |
| `durationMs` | Duration of command execution in milliseconds |

## Example: Dynamic AMI Lookup

**Step 1: Create a command/shell model to look up an AMI:**

```bash
# Create the model
swamp model create command/shell latest-ami --json
```

Edit `models/latest-ami/input.yaml`:

```yaml
name: latest-ami
version: 1
tags: {}
methods:
  execute:
    arguments:
      run: >-
        aws ec2 describe-images --owners amazon
        --filters "Name=name,Values=amzn2-ami-hvm-*-x86_64-gp2"
        --query "sort_by(Images,&CreationDate)[-1].ImageId"
        --output text
```

**Step 2: Create another model that references the shell output:**

```bash
# Create the EC2 instance model
swamp model create @user/ec2-instance my-instance --json
```

Edit `models/my-instance/input.yaml`:

```yaml
name: my-instance
version: 1
tags: {}
globalArguments:
  # Reference stdout from the command/shell model
  imageId: ${{ model.latest-ami.resource.result.result.attributes.stdout }}
  instanceType: t3.micro
  tags:
    Name: ${{ self.name }}
```

## Example: Security Group Lookup

```bash
# Create and configure the security group lookup model
swamp model create command/shell default-sg --json
```

Edit `models/default-sg/input.yaml`:

```yaml
name: default-sg
version: 1
tags: {}
methods:
  execute:
    arguments:
      run: >-
        aws ec2 describe-security-groups
        --filters "Name=group-name,Values=default"
        --query "SecurityGroups[0].GroupId"
        --output text
```

```bash
# Create an EC2 instance that references the security group
swamp model create @user/ec2 my-server --json
```

Edit `models/my-server/input.yaml`:

```yaml
name: my-server
version: 1
tags: {}
globalArguments:
  securityGroupIds:
    - ${{ model.default-sg.resource.result.result.attributes.stdout }}
```

## Example: Chaining Multiple Lookups

```bash
# Step 1: Create VPC lookup model
swamp model create command/shell vpc-lookup --json
```

Edit `models/vpc-lookup/input.yaml`:

```yaml
name: vpc-lookup
version: 1
tags: {}
methods:
  execute:
    arguments:
      run: >-
        aws ec2 describe-vpcs --filters "Name=isDefault,Values=true"
        --query "Vpcs[0].VpcId" --output text
```

```bash
# Step 2: Create subnet lookup that references the VPC
swamp model create command/shell subnet-lookup --json
```

Edit `models/subnet-lookup/input.yaml`:

```yaml
name: subnet-lookup
version: 1
tags: {}
methods:
  execute:
    arguments:
      run: >-
        aws ec2 describe-subnets
        --filters "Name=vpc-id,Values=${{ model.vpc-lookup.resource.result.result.attributes.stdout }}"
        --query "Subnets[0].SubnetId" --output text
```

```bash
# Step 3: Create instance model that uses both lookups
swamp model create @user/ec2-instance my-instance --json
```

Edit `models/my-instance/input.yaml`:

```yaml
name: my-instance
version: 1
tags: {}
globalArguments:
  subnetId: ${{ model.subnet-lookup.resource.result.result.attributes.stdout }}
  vpcId: ${{ model.vpc-lookup.resource.result.result.attributes.stdout }}
```
