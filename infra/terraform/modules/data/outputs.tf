output "db_instance_identifier" {
  value = aws_db_instance.this.identifier
}

output "db_address" {
  value = aws_db_instance.this.address
}

output "db_port" {
  value = aws_db_instance.this.port
}

output "db_arn" {
  value = aws_db_instance.this.arn
}

output "db_master_secret_arn" {
  description = <<-EOT
    The AWS-managed master credential.

    Only migrations and operator access use it. The application connects as
    `relayd_app` or `relayd_global`, whose credentials are separate secrets —
    the master has BYPASSRLS by virtue of being the owner, and handing it to
    a request path would make layer four decorative.
  EOT
  value = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "redis_reader_endpoint" {
  value = aws_elasticache_replication_group.this.reader_endpoint_address
}

output "redis_port" {
  value = aws_elasticache_replication_group.this.port
}

output "redis_arn" {
  value = aws_elasticache_replication_group.this.arn
}
