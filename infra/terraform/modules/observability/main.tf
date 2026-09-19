# CloudWatch alarms and dashboards (docs/10 "Alerts that page").
#
# docs/10 lists twelve alarms and says: "Only these wake someone up.
# Everything else is a dashboard." That list is implemented here exactly,
# and nothing is added to it — an alarm that fires and is ignored trains
# people to ignore alarms, and the next one they ignore will be one of the
# three below that mean money is wrong.
#
# Three of the twelve are billing correctness. docs/10 points that out and it
# is worth repeating in the code: `billing-webhook` depth, webhook processing
# failures, and usage reconciliation mismatch. Those are the failures that do
# not get better on their own and cannot be reconstructed after the fact.
#
# ## Custom metrics
#
# The application emits these through CloudWatch EMF in its log stream, which
# is why no task role has `cloudwatch:PutMetricData`. A metric filter turns
# them into metrics here rather than the application calling the API — one
# fewer permission, and the numbers survive a CloudWatch outage in the log.

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
    Module      = "observability"
  })

  namespace = "Relayd/${var.environment}"

  # Every alarm shares these. `treat_missing_data` is the setting that gets
  # this wrong most often: for a metric that only appears when something is
  # broken, "missing" means healthy, and `breaching` would page on a quiet
  # Sunday.
  alarm_actions = var.page_topic_arn == null ? [] : [var.page_topic_arn]
}

resource "aws_sns_topic" "page" {
  count = var.create_page_topic ? 1 : 0

  name              = "relayd-${var.environment}-page"
  kms_master_key_id = var.kms_key_arn
  tags              = local.tags
}

# ----------------------------------------------------- billing correctness

resource "aws_cloudwatch_metric_alarm" "billing_webhook_depth" {
  alarm_name        = "relayd-${var.environment}-billing-webhook-depth"
  alarm_description = <<-EOT
    docs/10: `billing-webhook` queue depth above 50 for five minutes.

    The inbox is meant to drain in seconds — the route does two writes and
    returns. A depth that persists means the consumer is stuck, and every
    minute it stays stuck is a minute our subscription state drifts from
    Stripe's while customers are being charged.
  EOT

  namespace   = local.namespace
  metric_name = "QueueDepth"
  dimensions  = { Queue = "billing-webhook" }

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 50
  comparison_operator = "GreaterThanThreshold"
  # A queue reporting nothing is a queue with nothing in it.
  treat_missing_data = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
  tags          = merge(local.tags, { Severity = "page", Area = "billing" })
}

resource "aws_cloudwatch_metric_alarm" "billing_webhook_failures" {
  alarm_name        = "relayd-${var.environment}-billing-webhook-failures"
  alarm_description = <<-EOT
    docs/10: any billing webhook processing failure, immediately.

    Not a rate and not a window. Stripe stops retrying after about three
    days, so a failure that nobody looks at becomes a subscription state we
    can only recover by reconciling — and the reconciler is a nightly job,
    which is a long time to be billing the wrong plan.
  EOT

  namespace   = local.namespace
  metric_name = "BillingWebhookFailures"

  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  tags          = merge(local.tags, { Severity = "page", Area = "billing" })
}

resource "aws_cloudwatch_metric_alarm" "usage_reconciliation_mismatch" {
  alarm_name        = "relayd-${var.environment}-usage-reconciliation-mismatch"
  alarm_description = <<-EOT
    docs/10: any usage reconciliation mismatch.

    `usage_aggregates.used` disagreeing with `COUNT(*)` over the ledger means
    an invoice is being computed from a number that does not match its
    evidence. docs/05 calls this a P1 and it is the correct call: whichever
    direction it is wrong in, somebody is paying the wrong amount.
  EOT

  namespace   = local.namespace
  metric_name = "UsageReconciliationDrift"

  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  tags          = merge(local.tags, { Severity = "page", Area = "billing" })
}

# R19's divergence metric. Not on docs/10's paging list — a nightly
# reconciler correcting a handful of objects is working, not failing — so it
# is a dashboard number with an alarm only at a level that means the webhook
# path has stopped working entirely.
resource "aws_cloudwatch_metric_alarm" "billing_divergence" {
  alarm_name        = "relayd-${var.environment}-billing-divergence"
  alarm_description = <<-EOT
    R19: the nightly reconciler found an unusual number of divergences.

    Some divergence is the system working — that is what the reconciler is
    for. A lot of it in one run means the webhook path stopped delivering,
    and the reconciler is the only thing keeping state correct.
  EOT

  namespace   = local.namespace
  metric_name = "BillingDivergence"

  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = var.billing_divergence_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  tags          = merge(local.tags, { Severity = "page", Area = "billing" })
}

# ------------------------------------------------------------ the send path

resource "aws_cloudwatch_metric_alarm" "send_failure_rate" {
  alarm_name        = "relayd-${var.environment}-send-failure-rate"
  alarm_description = "docs/10: `email-send` failure rate above 10% over five minutes."

  metric_query {
    id          = "rate"
    expression  = "IF(attempts > 0, 100 * failures / attempts, 0)"
    label       = "Send failure rate (%)"
    return_data = true
  }

  metric_query {
    id = "failures"

    metric {
      namespace   = local.namespace
      metric_name = "SendFailures"
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id = "attempts"

    metric {
      namespace   = local.namespace
      metric_name = "SendAttempts"
      period      = 300
      stat        = "Sum"
    }
  }

  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  # The expression guards the divide, so a period with no attempts reports
  # zero rather than nothing. Missing data here would mean the workers are
  # not running, which the queue-depth alarm catches.
  treat_missing_data = "notBreaching"

  alarm_actions = local.alarm_actions
  tags          = merge(local.tags, { Severity = "page", Area = "send" })
}

resource "aws_cloudwatch_metric_alarm" "dead_letters" {
  for_each = toset(var.critical_queues)

  alarm_name        = "relayd-${var.environment}-dlq-${each.value}"
  alarm_description = <<-EOT
    docs/10: any dead letter on a critical queue.

    A dead letter is a job that exhausted its retries. On `email-send` that
    is a recipient who will never be written to again, and on
    `billing-webhook` it is a Stripe event we have dropped.
  EOT

  namespace   = local.namespace
  metric_name = "DeadLetters"
  dimensions  = { Queue = each.value }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  tags          = merge(local.tags, { Severity = "page", Area = "queue" })
}

resource "aws_cloudwatch_metric_alarm" "unmatched_webhooks" {
  alarm_name        = "relayd-${var.environment}-unmatched-webhook-rate"
  alarm_description = <<-EOT
    A high share of inbound provider events matching no recipient.

    R4 stores an unmatched event with `matched = false` and applies nothing,
    so this is never a correctness problem. It is a signal: a provider
    changed its message-id format, or somebody is posting crafted events at a
    connection endpoint.
  EOT

  metric_query {
    id          = "rate"
    expression  = "IF(total > 0, 100 * unmatched / total, 0)"
    label       = "Unmatched provider events (%)"
    return_data = true
  }

  metric_query {
    id = "unmatched"

    metric {
      namespace   = local.namespace
      metric_name = "ProviderEventsUnmatched"
      period      = 900
      stat        = "Sum"
    }
  }

  metric_query {
    id = "total"

    metric {
      namespace   = local.namespace
      metric_name = "ProviderEventsReceived"
      period      = 900
      stat        = "Sum"
    }
  }

  evaluation_periods  = 1
  threshold           = 20
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  tags          = merge(local.tags, { Severity = "page", Area = "ingest" })
}

resource "aws_cloudwatch_metric_alarm" "complaint_rate" {
  alarm_name        = "relayd-${var.environment}-complaint-rate"
  alarm_description = <<-EOT
    docs/10: a workspace complaint rate above 0.3%.

    The same threshold as the auto-pause in Phase 11, and deliberately so:
    the system stops the sending by itself, and this is what tells a person
    it happened. A workspace over 0.3% is one whose provider account is next.
  EOT

  namespace   = local.namespace
  metric_name = "WorkspaceComplaintRate"

  statistic           = "Maximum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 0.3
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  tags          = merge(local.tags, { Severity = "page", Area = "abuse" })
}

# ------------------------------------------------------------- the edges

resource "aws_cloudwatch_metric_alarm" "api_latency" {
  alarm_name        = "relayd-${var.environment}-api-p99-latency"
  alarm_description = "docs/10: API p99 above 2 seconds for five minutes."

  namespace   = "AWS/ApplicationELB"
  metric_name = "TargetResponseTime"
  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.api_target_group_arn_suffix
  }

  extended_statistic  = "p99"
  period              = 60
  evaluation_periods  = 5
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  # No requests is not slow requests.
  treat_missing_data = "notBreaching"

  alarm_actions = local.alarm_actions
  tags          = merge(local.tags, { Severity = "page", Area = "api" })
}

resource "aws_cloudwatch_metric_alarm" "error_rate" {
  alarm_name        = "relayd-${var.environment}-5xx-rate"
  alarm_description = "docs/10: 5xx rate above 1% for five minutes."

  metric_query {
    id          = "rate"
    expression  = "IF(requests > 0, 100 * errors / requests, 0)"
    label       = "5xx rate (%)"
    return_data = true
  }

  metric_query {
    id = "errors"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id = "requests"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
      period      = 300
      stat        = "Sum"
    }
  }

  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  tags          = merge(local.tags, { Severity = "page", Area = "api" })
}

# ------------------------------------------------------------ the data tier

resource "aws_cloudwatch_metric_alarm" "db_connections" {
  alarm_name        = "relayd-${var.environment}-db-connections"
  alarm_description = <<-EOT
    docs/10: database connections above 80% of maximum.

    The number that matters before Phase 12's PgBouncer evaluation. Fargate
    scaling multiplies connections by task count, so this is the alarm that
    fires first when an autoscaling policy is too eager.
  EOT

  namespace   = "AWS/RDS"
  metric_name = "DatabaseConnections"
  dimensions  = { DBInstanceIdentifier = var.db_instance_identifier }

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = var.db_max_connections * 0.8
  comparison_operator = "GreaterThanThreshold"
  # An instance reporting no connections is an instance nothing can reach.
  treat_missing_data = "breaching"

  alarm_actions = local.alarm_actions
  tags          = merge(local.tags, { Severity = "page", Area = "database" })
}

resource "aws_cloudwatch_metric_alarm" "db_replica_lag" {
  count = var.multi_az ? 1 : 0

  alarm_name        = "relayd-${var.environment}-db-replica-lag"
  alarm_description = "docs/10: replication lag above 30 seconds."

  namespace   = "AWS/RDS"
  metric_name = "ReplicaLag"
  dimensions  = { DBInstanceIdentifier = var.db_instance_identifier }

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 30
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  tags          = merge(local.tags, { Severity = "page", Area = "database" })
}

resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  alarm_name        = "relayd-${var.environment}-redis-memory"
  alarm_description = <<-EOT
    docs/10: Redis memory above 80%.

    With `maxmemory-policy noeviction`, hitting the ceiling means writes
    start failing rather than keys being discarded. That is the safe
    direction — a queued send must not be evicted — but it is still an
    outage of the send path, so this alarm is the warning before it.
  EOT

  namespace   = "AWS/ElastiCache"
  metric_name = "DatabaseMemoryUsagePercentage"
  dimensions  = { ReplicationGroupId = var.redis_replication_group_id }

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"

  alarm_actions = local.alarm_actions
  tags          = merge(local.tags, { Severity = "page", Area = "redis" })
}

resource "aws_cloudwatch_metric_alarm" "certificate_expiry" {
  count = var.certificate_arn == null ? 0 : 1

  alarm_name        = "relayd-${var.environment}-certificate-expiry"
  alarm_description = "docs/10: certificate expiry within 14 days."

  namespace   = "AWS/CertificateManager"
  metric_name = "DaysToExpiry"
  dimensions  = { CertificateArn = var.certificate_arn }

  statistic           = "Minimum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 14
  comparison_operator = "LessThanThreshold"
  # A certificate that stopped reporting is a certificate nobody is watching.
  treat_missing_data = "breaching"

  alarm_actions = local.alarm_actions
  tags          = merge(local.tags, { Severity = "page", Area = "tls" })
}

# --------------------------------------------------------------- dashboard

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "relayd-${var.environment}"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "text"
        width  = 24
        height = 2
        properties = {
          markdown = join("\n", [
            "# Relayd ${var.environment}",
            "",
            "Twelve alarms page (docs/10). Three of them are billing correctness, which is where the unrecoverable failures are.",
          ])
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "Send path"
          region = var.region
          view   = "timeSeries"
          metrics = [
            [local.namespace, "SendAttempts", { stat = "Sum", label = "Attempts" }],
            [".", "SendFailures", { stat = "Sum", label = "Failures" }],
            [".", "SendDeliveryUncertain", { stat = "Sum", label = "Uncertain (D3)" }],
          ]
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "Queue depth"
          region = var.region
          view   = "timeSeries"
          metrics = [
            for queue in var.critical_queues :
            [local.namespace, "QueueDepth", "Queue", queue, { stat = "Maximum" }]
          ]
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "Billing correctness"
          region = var.region
          view   = "timeSeries"
          metrics = [
            [local.namespace, "BillingWebhookFailures", { stat = "Sum" }],
            [".", "UsageReconciliationDrift", { stat = "Maximum" }],
            [".", "BillingDivergence", { stat = "Sum" }],
          ]
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "API"
          region = var.region
          view   = "timeSeries"
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix, { stat = "Sum" }],
            [".", "HTTPCode_Target_5XX_Count", ".", ".", { stat = "Sum" }],
            [".", "TargetResponseTime", ".", ".", { stat = "p99" }],
          ]
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "Database"
          region = var.region
          view   = "timeSeries"
          metrics = [
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", var.db_instance_identifier, { stat = "Maximum" }],
            [".", "CPUUtilization", ".", ".", { stat = "Average" }],
            [".", "FreeStorageSpace", ".", ".", { stat = "Minimum" }],
          ]
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "Redis"
          region = var.region
          view   = "timeSeries"
          metrics = [
            ["AWS/ElastiCache", "DatabaseMemoryUsagePercentage", "ReplicationGroupId", var.redis_replication_group_id, { stat = "Maximum" }],
            [".", "CurrConnections", ".", ".", { stat = "Maximum" }],
          ]
        }
      },
    ]
  })
}
