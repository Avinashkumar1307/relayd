# The VPC (docs/10 "AWS topology"; INVARIANTS R34).
#
# Three tiers, and the reason for the third is the one worth stating: the data
# subnets have no route to the internet at all. Not a restrictive security
# group over a routable subnet — no route. A misconfigured group is a mistake
# somebody makes; a missing route is a thing that cannot be made to work.
#
# Public holds the ALB and the NAT gateway and nothing else. App tasks are
# private with NAT egress, because they genuinely must reach customer provider
# APIs and Stripe. Data accepts 5432 and 6379 from the app group and nothing
# from anywhere.
#
# ## Why the VPC endpoints are not optional
#
# F34: NAT data processing is charged per gigabyte, and a worker calling a
# provider API several million times a day moves real volume. Everything that
# can leave through an endpoint does — S3, ECR, Secrets Manager, CloudWatch
# Logs — so NAT carries only genuine third-party traffic. The S3 and DynamoDB
# gateway endpoints are free; the interface endpoints cost an hourly rate that
# is well under what they save at any volume we would notice.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  # Two AZs. Multi-AZ RDS needs two, the ALB needs two, and a third buys
  # nothing until there is enough traffic for the cross-AZ transfer to matter.
  azs = slice(data.aws_availability_zones.available.names, 0, 2)

  tags = merge(var.tags, {
    Environment = var.environment
    Module      = "network"
  })
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_region" "current" {}

resource "aws_vpc" "this" {
  cidr_block = var.vpc_cidr

  # Both required for interface VPC endpoints to resolve to private addresses.
  # Without them the endpoint exists and every call still goes out through NAT,
  # which is the failure mode where the bill is the only symptom.
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.tags, { Name = "relayd-${var.environment}" })
}

# ---------------------------------------------------------------- subnets

resource "aws_subnet" "public" {
  count = length(local.azs)

  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index)

  # The ALB needs public addresses. Nothing else lives here.
  map_public_ip_on_launch = true

  tags = merge(local.tags, {
    Name = "relayd-${var.environment}-public-${local.azs[count.index]}"
    Tier = "public"
  })
}

resource "aws_subnet" "app" {
  count = length(local.azs)

  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  # /23 per AZ: 512 addresses, which is far more Fargate tasks than we will
  # run and cheap to have reserved.
  cidr_block = cidrsubnet(var.vpc_cidr, 7, count.index + 5)

  tags = merge(local.tags, {
    Name = "relayd-${var.environment}-app-${local.azs[count.index]}"
    Tier = "app"
  })
}

resource "aws_subnet" "data" {
  count = length(local.azs)

  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 20)

  tags = merge(local.tags, {
    Name = "relayd-${var.environment}-data-${local.azs[count.index]}"
    Tier = "data"
  })
}

# ------------------------------------------------------------- gateways

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "relayd-${var.environment}" })
}

# One NAT gateway per AZ in production, one shared in staging.
#
# Per-AZ removes a cross-AZ data charge and a single point of failure; shared
# halves a fixed hourly cost in an environment that can be rebuilt. F34's
# point about measuring first applies to the *data* charge, not to this.
resource "aws_eip" "nat" {
  count  = var.nat_gateway_per_az ? length(local.azs) : 1
  domain = "vpc"
  tags   = merge(local.tags, { Name = "relayd-${var.environment}-nat-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count = var.nat_gateway_per_az ? length(local.azs) : 1

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags       = merge(local.tags, { Name = "relayd-${var.environment}-${count.index}" })
  depends_on = [aws_internet_gateway.this]
}

# --------------------------------------------------------------- routing

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "relayd-${var.environment}-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = length(local.azs)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "app" {
  count = length(local.azs)

  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "relayd-${var.environment}-app-${count.index}" })
}

resource "aws_route" "app_nat" {
  count = length(local.azs)

  route_table_id         = aws_route_table.app[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[var.nat_gateway_per_az ? count.index : 0].id
}

resource "aws_route_table_association" "app" {
  count = length(local.azs)

  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app[count.index].id
}

# The data route table has no default route, deliberately. Everything the
# database tier needs — nothing — is reachable without one, and a subnet with
# no path out cannot be talked out of it by a security-group change.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "relayd-${var.environment}-data" })
}

resource "aws_route_table_association" "data" {
  count = length(local.azs)

  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

# -------------------------------------------------------- vpc endpoints

# Gateway endpoints are free and route-table based, so they attach to the app
# tables and to the data table — the latter so a future read of an S3 export
# from inside the data tier does not require punching a hole.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.app[*].id, [aws_route_table.data.id])

  tags = merge(local.tags, { Name = "relayd-${var.environment}-s3" })
}

resource "aws_security_group" "endpoints" {
  name        = "relayd-${var.environment}-endpoints"
  description = "Interface VPC endpoints"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "relayd-${var.environment}-endpoints" })
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_app" {
  security_group_id            = aws_security_group.endpoints.id
  description                  = "HTTPS from app tasks"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
}

# Interface endpoints, per R34 and F34. `ecr.api` and `ecr.dkr` are both
# needed: one for the registry API, one for the image layers, and an image
# pull fails on the layers if only the first is present.
locals {
  interface_endpoints = [
    "ecr.api",
    "ecr.dkr",
    "secretsmanager",
    "logs",
    "kms",
  ]
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset(local.interface_endpoints)

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${data.aws_region.current.name}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.app[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true

  tags = merge(local.tags, { Name = "relayd-${var.environment}-${each.value}" })
}

# ------------------------------------------------------- security groups

resource "aws_security_group" "alb" {
  name        = "relayd-${var.environment}-alb"
  description = "Public load balancer"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "relayd-${var.environment}-alb" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from anywhere"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

# Port 80 exists only to redirect. Without it a customer typing the hostname
# gets a connection refused rather than a redirect to https, and concludes we
# are down.
resource "aws_vpc_security_group_ingress_rule" "alb_http_redirect" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP, redirected to HTTPS at the listener"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To app tasks"
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "-1"
}

resource "aws_security_group" "app" {
  name        = "relayd-${var.environment}-app"
  description = "ECS tasks"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "relayd-${var.environment}-app" })
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "From the load balancer"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.app_port
  to_port                      = var.app_port
  ip_protocol                  = "tcp"
}

# Egress is open because the whole job of the worker tier is calling somebody
# else's API — SES, SendGrid, Mailgun, Brevo, Stripe, and whatever SMTP host a
# customer names. An allow-list of destinations here would be a list we cannot
# write, since the customer chooses.
resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "Provider APIs, Stripe, and AWS endpoints"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "data" {
  name        = "relayd-${var.environment}-data"
  description = "RDS and ElastiCache"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "relayd-${var.environment}-data" })
}

resource "aws_vpc_security_group_ingress_rule" "data_postgres" {
  security_group_id            = aws_security_group.data.id
  description                  = "Postgres from app tasks"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "data_redis" {
  security_group_id            = aws_security_group.data.id
  description                  = "Redis from app tasks"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

# No egress rule at all. The data tier initiates nothing, and the absence of a
# rule is the statement — an empty allow-list would read as an oversight.
