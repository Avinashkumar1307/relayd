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

variable "image" {
  description = <<-EOT
    The image to run, by digest.

    A digest and not a tag: CI promotes the exact artifact it tested through
    staging into production, and a tag can be moved between the two.
  EOT
  type = string
}

variable "services" {
  description = <<-EOT
    One entry per process type.

    `path_patterns` null means the service takes no traffic and gets no
    target group. `singleton` means exactly one task at a time, which is the
    scheduler.
  EOT
  type = map(object({
    cpu               = number
    memory            = number
    desired_count     = number
    max_count         = number
    singleton         = bool
    path_patterns     = list(string)
    listener_priority = optional(number)
  }))
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "app_subnet_ids" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "app_security_group_id" {
  type = string
}

variable "execution_role_arn" {
  type = string
}

variable "task_role_arns" {
  description = "One per process type, plus whichever the migration task uses."
  type        = map(string)
}

variable "certificate_arn" {
  description = "ACM certificate for the ALB, in this region."
  type        = string
}

variable "kms_key_arn" {
  type = string
}

variable "app_port" {
  type    = number
  default = 3000
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "environment_variables" {
  description = "Non-secret configuration. Anything secret goes in secret_arns."
  type        = map(string)
  default     = {}
}

variable "secret_arns" {
  description = "Environment variable name to Secrets Manager ARN, injected by the execution role."
  type        = map(string)
  default     = {}
}

variable "access_log_bucket" {
  description = "ALB access logs. Null disables them."
  type        = string
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
