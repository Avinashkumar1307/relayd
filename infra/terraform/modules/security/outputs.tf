output "kms_key_arn" {
  value = aws_kms_key.this.arn
}

output "kms_key_id" {
  value = aws_kms_key.this.key_id
}

output "execution_role_arn" {
  description = "What ECS uses to start a task. Not what the application runs as."
  value       = aws_iam_role.execution.arn
}

output "task_role_arns" {
  description = "One per process type, keyed by process."
  value       = { for process, role in aws_iam_role.task : process => role.arn }
}

output "workspace_secret_prefix" {
  description = <<-EOT
    R21's path, without the wildcard.

    Exported so the application and the policy cannot disagree about where a
    credential lives — a secret written outside this prefix is one no task
    role can read, and the failure arrives at send time.
  EOT
  value = "relayd/${var.environment}/ws"
}

output "app_secret_prefix" {
  value = "relayd/${var.environment}/app"
}
