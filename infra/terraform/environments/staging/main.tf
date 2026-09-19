# Staging (docs/10 "Environments").
#
# A smaller production, not a different system: the same modules, the same
# wiring, the same alarm thresholds. Only the sizing and the redundancy
# differ, and each difference is one F34 asks for — do not pay for
# availability in an environment whose recovery plan is `terraform apply`.
#
#   Single-AZ RDS         rebuildable in under an hour, which is its RTO
#   One Redis node        no failover to test that production does not have
#   One task per service  enough to exercise every path
#   7-day backups         long enough to find out a restore works
#   One NAT gateway       halves a fixed hourly cost
#
# Synthetic and anonymised data only. Never a production dump — docs/10 is
# explicit, and the reason is that staging has weaker access control on
# purpose so that people can debug in it.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # S3 with versioning and DynamoDB locking, per docs/10. The bucket and
  # table are created out of band — a backend cannot bootstrap itself — and
  # the values are supplied by `-backend-config` so this file names no
  # account.
  backend "s3" {
    key     = "staging/terraform.tfstate"
    encrypt = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Application = "relayd"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

# CloudFront certificates must live in us-east-1 whatever the region the rest
# of the stack is in.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

data "aws_caller_identity" "current" {}

locals {
  environment = "staging"

  # One task per service (docs/10). Enough to exercise every path.
  services = {
    api = {
      cpu               = 512
      memory            = 1024
      desired_count     = 1
      max_count         = 4
      singleton         = false
      path_patterns     = ["/api/*"]
      listener_priority = 100
    }

    # Same shape as production at a quarter of the ceiling. Keeping `edge`
    # separate here is not about capacity — it is so staging exercises the
    # same two-target-group routing production does.
    edge = {
      cpu               = 512
      memory            = 1024
      desired_count     = 1
      max_count         = 4
      singleton         = false
      path_patterns     = ["/o/*", "/c/*", "/u/*", "/ingest/*"]
      listener_priority = 200
    }

    worker = {
      cpu           = 1024
      memory        = 2048
      desired_count = 1
      max_count     = 4
      singleton     = false
      path_patterns = null
    }

    # Exactly one. Leader-elected, and the deployment settings in the compute
    # module keep it that way through a deploy.
    scheduler = {
      cpu           = 512
      memory        = 1024
      desired_count = 1
      max_count     = 1
      singleton     = true
      path_patterns = null
    }
  }
}

module "security" {
  source = "../../modules/security"

  environment          = local.environment
  product_email_domain = var.product_email_domain
  uploads_bucket_arn   = module.storage.uploads_bucket_arn
  exports_bucket_arn   = module.storage.exports_bucket_arn
}

module "network" {
  source = "../../modules/network"

  environment        = local.environment
  vpc_cidr           = var.vpc_cidr
  nat_gateway_per_az = false
}

module "storage" {
  source = "../../modules/storage"

  environment     = local.environment
  account_suffix  = data.aws_caller_identity.current.account_id
  kms_key_arn     = module.security.kms_key_arn
  web_aliases     = [var.web_hostname]
  certificate_arn = var.cloudfront_certificate_arn
  api_origin      = "https://${var.api_hostname}"
  web_acl_arn     = var.web_acl_arn
}

module "data" {
  source = "../../modules/data"

  environment            = local.environment
  data_subnet_ids        = module.network.data_subnet_ids
  data_security_group_id = module.network.data_security_group_id
  kms_key_arn            = module.security.kms_key_arn

  db_instance_class     = var.db_instance_class
  db_allocated_storage  = 50
  db_max_allocated_storage = 200
  multi_az              = false
  backup_retention_days = 7

  redis_node_type      = var.redis_node_type
  redis_node_count     = 1
  redis_auth_token     = var.redis_auth_token
  redis_log_group_name = aws_cloudwatch_log_group.redis.name
}

resource "aws_cloudwatch_log_group" "redis" {
  name              = "/relayd/${local.environment}/redis"
  retention_in_days = 7
  kms_key_id        = module.security.kms_key_arn
}

module "compute" {
  source = "../../modules/compute"

  environment = local.environment
  region      = var.region
  image       = var.image
  services    = local.services

  vpc_id                = module.network.vpc_id
  public_subnet_ids     = module.network.public_subnet_ids
  app_subnet_ids        = module.network.app_subnet_ids
  alb_security_group_id = module.network.alb_security_group_id
  app_security_group_id = module.network.app_security_group_id

  execution_role_arn = module.security.execution_role_arn
  task_role_arns     = module.security.task_role_arns
  certificate_arn    = var.alb_certificate_arn
  kms_key_arn        = module.security.kms_key_arn

  log_retention_days = 14

  environment_variables = {
    RELAYD_APP_URL       = "https://${var.web_hostname}"
    RELAYD_API_URL       = "https://${var.api_hostname}"
    RELAYD_SECRET_PREFIX = module.security.workspace_secret_prefix
    S3_UPLOADS_BUCKET    = module.storage.bucket_names["uploads"]
    S3_EXPORTS_BUCKET    = module.storage.bucket_names["exports"]
    S3_ARCHIVE_BUCKET    = module.storage.bucket_names["archive"]
  }

  secret_arns = var.secret_arns
}

module "observability" {
  source = "../../modules/observability"

  environment = local.environment
  region      = var.region
  kms_key_arn = module.security.kms_key_arn

  page_topic_arn    = var.page_topic_arn
  create_page_topic = var.page_topic_arn == null

  alb_arn_suffix              = module.compute.alb_arn_suffix
  api_target_group_arn_suffix = module.compute.target_group_arn_suffixes["api"]

  db_instance_identifier = module.data.db_instance_identifier
  db_max_connections     = var.db_max_connections
  multi_az               = false

  redis_replication_group_id = "relayd-${local.environment}"
  certificate_arn            = var.alb_certificate_arn
}

# ------------------------------------------------------------------ DNS

data "aws_route53_zone" "this" {
  count = var.route53_zone_id == null ? 0 : 1

  zone_id = var.route53_zone_id
}

resource "aws_route53_record" "api" {
  count = var.route53_zone_id == null ? 0 : 1

  zone_id = var.route53_zone_id
  name    = var.api_hostname
  type    = "A"

  alias {
    name                   = module.compute.alb_dns_name
    zone_id                = module.compute.alb_zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "web" {
  count = var.route53_zone_id == null ? 0 : 1

  zone_id = var.route53_zone_id
  name    = var.web_hostname
  type    = "A"

  alias {
    name    = module.storage.cloudfront_domain_name
    # The fixed hosted zone id for every CloudFront distribution.
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}
