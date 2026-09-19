output "page_topic_arn" {
  description = "The topic created here, if any. Null when one was supplied."
  value       = var.create_page_topic ? aws_sns_topic.page[0].arn : var.page_topic_arn
}

output "dashboard_name" {
  value = aws_cloudwatch_dashboard.main.dashboard_name
}

output "alarm_names" {
  description = "Every alarm that pages. CI asserts this list is not empty."
  value = concat(
    [
      aws_cloudwatch_metric_alarm.billing_webhook_depth.alarm_name,
      aws_cloudwatch_metric_alarm.billing_webhook_failures.alarm_name,
      aws_cloudwatch_metric_alarm.usage_reconciliation_mismatch.alarm_name,
      aws_cloudwatch_metric_alarm.billing_divergence.alarm_name,
      aws_cloudwatch_metric_alarm.send_failure_rate.alarm_name,
      aws_cloudwatch_metric_alarm.unmatched_webhooks.alarm_name,
      aws_cloudwatch_metric_alarm.complaint_rate.alarm_name,
      aws_cloudwatch_metric_alarm.api_latency.alarm_name,
      aws_cloudwatch_metric_alarm.error_rate.alarm_name,
      aws_cloudwatch_metric_alarm.db_connections.alarm_name,
      aws_cloudwatch_metric_alarm.redis_memory.alarm_name,
    ],
    [for alarm in aws_cloudwatch_metric_alarm.dead_letters : alarm.alarm_name],
    var.multi_az ? [aws_cloudwatch_metric_alarm.db_replica_lag[0].alarm_name] : [],
    var.certificate_arn == null ? [] : [aws_cloudwatch_metric_alarm.certificate_expiry[0].alarm_name],
  )
}
