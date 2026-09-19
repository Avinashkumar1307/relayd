# RDS Postgres and ElastiCache Redis (docs/10; INVARIANTS R34).
#
# Two decisions here come from the review rather than the original design, and
# both are about not paying before measuring (F34):
#
#   **One Redis instance, not two.** The original split queue traffic from
#   rate-limiting traffic across separate instances before anything had been
#   measured. One instance with keyspace prefixes — `bull:`, `rl:`, `cache:` —
#   until there is a number that says otherwise. Splitting later is a
#   configuration change; un-splitting is a migration nobody does.
#
#   **Multi-AZ in production only.** Staging can be rebuilt from Terraform and
#   a seed script in under an hour, which is exactly what its RTO is for.
#   Doubling the line item to protect it buys nothing.
#
# PITR is on in both, because the thing PITR protects against — somebody
# deleting the wrong rows — happens in staging too, and staging is where you
# find out whether the restore procedure works.

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
  tags = merge(var.tags, {
    Environment = var.environment
    Module      = "data"
  })
}

# ------------------------------------------------------------------ RDS

resource "aws_db_subnet_group" "this" {
  name       = "relayd-${var.environment}"
  subnet_ids = var.data_subnet_ids
  tags       = local.tags
}

# Parameter group rather than the default, for three settings that matter to
# this application specifically.
resource "aws_db_parameter_group" "this" {
  name   = "relayd-${var.environment}-pg16"
  family = "postgres16"
  tags   = local.tags

  # Every statement over a second, so a slow query has a trail. Below a second
  # this fills the log with the send path and drowns what it is for.
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  # `pg_stat_statements` is how the Phase 12 index review gets its numbers. It
  # needs a reboot to load, so it is set now rather than when it is wanted.
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  # The scheduler takes transaction-scoped advisory locks and the partition
  # job creates tables. A statement that cannot get its lock should fail
  # rather than queue behind whatever is holding it — CLAUDE.md section 8 asks
  # for `lock_timeout` on partition creation, and this is the floor under it.
  parameter {
    name  = "lock_timeout"
    value = "5000"
  }

  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "this" {
  identifier     = "relayd-${var.environment}"
  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  db_name  = "relayd"
  username = "relayd_root"
  # Managed by AWS and rotated there. The application never uses this
  # credential: it connects as `relayd_app` or `relayd_global`, which
  # migration 0003 creates, and only those two have RLS-relevant grants.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.data_security_group_id]
  parameter_group_name   = aws_db_parameter_group.this.name

  multi_az = var.multi_az

  backup_retention_period = var.backup_retention_days
  # 03:00–04:00 UTC, before the European morning and after the American
  # evening. The nightly billing reconciler runs at 02:00, so the window does
  # not overlap the job most likely to be mid-write.
  backup_window      = "03:00-04:00"
  maintenance_window = "sun:04:30-sun:05:30"

  copy_tags_to_snapshot = true
  # The cross-region copy for DR is a separate lifecycle, driven by an AWS
  # Backup plan rather than by this resource, so a `terraform destroy` of the
  # instance cannot take the offsite copies with it.

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = var.environment == "production" ? 731 : 7

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  auto_minor_version_upgrade = true
  deletion_protection        = var.environment == "production"
  skip_final_snapshot        = var.environment != "production"
  final_snapshot_identifier  = var.environment == "production" ? "relayd-production-final-${formatdate("YYYYMMDDhhmm", timestamp())}" : null

  tags = merge(local.tags, { Name = "relayd-${var.environment}" })

  lifecycle {
    # The final snapshot name embeds a timestamp, which would otherwise show
    # as a diff on every plan.
    ignore_changes = [final_snapshot_identifier]
  }
}

# --------------------------------------------------------- ElastiCache

resource "aws_elasticache_subnet_group" "this" {
  name       = "relayd-${var.environment}"
  subnet_ids = var.data_subnet_ids
  tags       = local.tags
}

resource "aws_elasticache_parameter_group" "this" {
  name   = "relayd-${var.environment}-redis7"
  family = "redis7"
  tags   = local.tags

  # `noeviction`, and this is the important one.
  #
  # BullMQ keeps job state in Redis. An eviction policy that discards keys
  # under memory pressure silently deletes queued sends — the queue would
  # appear to drain and the emails would never go. Failing writes loudly is
  # recoverable; losing jobs quietly is not.
  #
  # CLAUDE.md section 9 says Redis is transport and Postgres is the system of
  # record, and the reconcilers exist for exactly this. But a reconciler that
  # has to rebuild the whole queue is a bad afternoon, and `noeviction` means
  # it stays hypothetical.
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "relayd-${var.environment}"
  description          = "Relayd queue, rate limiting and cache"

  engine         = "redis"
  engine_version = var.redis_version
  node_type      = var.redis_node_type
  port           = 6379

  # One node in staging, two with automatic failover in production. R34: one
  # instance with keyspace prefixes until measurement says otherwise — that is
  # about not splitting queue from cache, not about replicas.
  num_cache_clusters         = var.redis_node_count
  automatic_failover_enabled = var.redis_node_count > 1
  multi_az_enabled           = var.redis_node_count > 1

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [var.data_security_group_id]
  parameter_group_name = aws_elasticache_parameter_group.this.name

  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn
  transit_encryption_enabled = true
  # Auth token in Secrets Manager, supplied by the caller. Set here rather
  # than generated, so a rotation is a Terraform-free operation.
  auth_token = var.redis_auth_token

  snapshot_retention_limit = var.environment == "production" ? 7 : 1
  snapshot_window          = "02:00-03:00"

  maintenance_window       = "sun:05:30-sun:06:30"
  apply_immediately        = var.environment != "production"
  auto_minor_version_upgrade = true

  log_delivery_configuration {
    destination      = var.redis_log_group_name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  tags = merge(local.tags, { Name = "relayd-${var.environment}" })

  lifecycle {
    # Rotated out of band.
    ignore_changes = [auth_token]
  }
}
