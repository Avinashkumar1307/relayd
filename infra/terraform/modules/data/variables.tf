variable "environment" {
  type = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "data_subnet_ids" {
  description = "The subnets with no route to the internet."
  type        = list(string)
}

variable "data_security_group_id" {
  type = string
}

variable "kms_key_arn" {
  description = "Encrypts storage, snapshots, Performance Insights and the master secret."
  type        = string
}

# ------------------------------------------------------------------ RDS

variable "postgres_version" {
  description = "Postgres 16, per CLAUDE.md section 2."
  type        = string
  default     = "16.4"
}

variable "db_instance_class" {
  description = "docs/10: db.t4g.medium in staging, db.r7g.large or better in production."
  type        = string
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "db_max_allocated_storage" {
  description = <<-EOT
    The ceiling for storage autoscaling.

    Set rather than left unbounded: `email_events` grows without limit if a
    partition drop stops running, and a disk that silently grows to two
    terabytes is a bill nobody approved.
  EOT
  type    = number
  default = 500
}

variable "multi_az" {
  description = "Production only (R34, F34). Staging is rebuildable."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  description = "docs/10: 7 days in staging, 30 in production. Above zero also enables PITR."
  type        = number
  default     = 7

  validation {
    # Zero would disable automated backups and PITR with them, which is the
    # one setting here that cannot be fixed after the fact.
    condition     = var.backup_retention_days >= 1
    error_message = "backup_retention_days must be at least 1; zero disables PITR."
  }
}

# -------------------------------------------------------------- Redis

variable "redis_version" {
  type    = string
  default = "7.1"
}

variable "redis_node_type" {
  description = "docs/10: cache.t4g.micro in staging, cache.r7g.large in production."
  type        = string
}

variable "redis_node_count" {
  description = "1 in staging, 2 with automatic failover in production."
  type        = number
  default     = 1
}

variable "redis_auth_token" {
  description = "AUTH token. Supplied from Secrets Manager, never generated here."
  type        = string
  sensitive   = true
}

variable "redis_log_group_name" {
  description = "CloudWatch log group for the Redis slow log."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
