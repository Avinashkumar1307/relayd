variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "image" {
  description = <<-EOT
    The image digest CI is promoting.

    A digest, not a tag. Production runs the exact artifact staging tested
    (docs/10: "Build once, promote the same image digest"), and a tag can be
    moved between the two.
  EOT
  type = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image))
    error_message = "image must be pinned by digest, e.g. <repo>@sha256:<64 hex>. A tag is not promotable."
  }
}

variable "db_instance_class" {
  type    = string
  default = "db.r7g.large"
}

variable "db_max_connections" {
  description = "RDS derives this from instance memory; supply the real number for the 80% alarm."
  type        = number
  default     = 1000
}

variable "redis_node_type" {
  type    = string
  default = "cache.r7g.large"
}

variable "redis_auth_token" {
  type      = string
  sensitive = true
}

variable "web_hostname" {
  type = string
}

variable "api_hostname" {
  type = string
}

variable "alb_certificate_arn" {
  description = "ACM certificate in this region, for the ALB."
  type        = string
}

variable "cloudfront_certificate_arn" {
  description = "ACM certificate in us-east-1, for CloudFront."
  type        = string
}

variable "route53_zone_id" {
  description = "Null skips the DNS records, for a first apply before the zone exists."
  type        = string
  default     = null
}

variable "product_email_domain" {
  description = "Our own SES identity. Never a customer's domain (docs/10)."
  type        = string
}

variable "secret_arns" {
  description = "Environment variable name to Secrets Manager ARN, injected at task start."
  type        = map(string)
  default     = {}
}

variable "page_topic_arn" {
  description = "An existing SNS topic to page. Null creates one."
  type        = string
  default     = null
}

variable "web_acl_arn" {
  description = "WAF, which arrives with the Phase 11 hardening."
  type        = string
  default     = null
}
