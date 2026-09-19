variable "environment" {
  type = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "region" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "create_page_topic" {
  description = "Create the SNS topic. False when one already exists to route into."
  type        = bool
  default     = true
}

variable "page_topic_arn" {
  description = <<-EOT
    Where a paging alarm goes.

    Null wires the alarms up with no action, which is deliberate rather than
    broken: the alarm state is still visible and still recorded, and an
    environment with nobody on call should not pretend otherwise.
  EOT
  type    = string
  default = null
}

variable "critical_queues" {
  description = <<-EOT
    Queues where a dead letter pages.

    docs/10 says "dead letters on a critical queue", without listing them.
    These four are the ones where a lost job is not recoverable by rerunning
    something: a send that will never be retried, a Stripe event we dropped,
    a campaign stuck mid-launch, and a provider event never applied.
  EOT
  type    = list(string)
  default = ["email-send", "billing-webhook", "campaign-dispatch", "provider-events"]
}

variable "billing_divergence_threshold" {
  description = <<-EOT
    Divergences in one nightly reconciler run before it pages.

    Not zero. Some divergence is the reconciler doing its job — an event
    Stripe never delivered is exactly what it exists to catch. A lot of it in
    one run means the webhook path has stopped.
  EOT
  type    = number
  default = 25
}

variable "alb_arn_suffix" {
  type = string
}

variable "api_target_group_arn_suffix" {
  type = string
}

variable "db_instance_identifier" {
  type = string
}

variable "db_max_connections" {
  description = <<-EOT
    The instance's connection ceiling, for the 80% alarm.

    Supplied rather than derived: RDS computes it from a formula over
    instance memory, and hard-coding the result of that formula somewhere
    Terraform cannot check it is how the alarm ends up on the wrong number.
  EOT
  type = number
}

variable "multi_az" {
  description = "Replica lag only exists where there is a replica."
  type        = bool
  default     = false
}

variable "redis_replication_group_id" {
  type = string
}

variable "certificate_arn" {
  description = "Null skips the expiry alarm."
  type        = string
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
