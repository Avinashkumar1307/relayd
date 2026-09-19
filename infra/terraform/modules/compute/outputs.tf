output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "service_names" {
  value = { for name, service in aws_ecs_service.this : name => service.name }
}

output "task_definition_arns" {
  value = { for name, definition in aws_ecs_task_definition.this : name => definition.arn }
}

output "migrate_task_definition_family" {
  description = "CI runs this with `aws ecs run-task` before every service update."
  value       = aws_ecs_task_definition.migrate.family
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_zone_id" {
  value = aws_lb.this.zone_id
}

output "alb_arn_suffix" {
  description = "For the CloudWatch alarms on request count, latency and 5xx."
  value       = aws_lb.this.arn_suffix
}

output "target_group_arn_suffixes" {
  value = { for name, group in aws_lb_target_group.this : name => group.arn_suffix }
}

output "log_group_names" {
  value = { for name, group in aws_cloudwatch_log_group.app : name => group.name }
}
