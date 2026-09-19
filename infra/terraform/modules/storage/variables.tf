variable "environment" {
  type = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "account_suffix" {
  description = "Appended to bucket names, which are globally unique. Usually the account id."
  type        = string
}

variable "kms_key_arn" {
  type = string
}

variable "web_aliases" {
  description = "Hostnames CloudFront answers on. Empty until a certificate exists."
  type        = list(string)
  default     = []
}

variable "certificate_arn" {
  description = "An ACM certificate in us-east-1. Null falls back to the CloudFront default domain."
  type        = string
  default     = null
}

variable "api_origin" {
  description = "The API origin, for the SPA's connect-src. It is on a different host from the SPA."
  type        = string
}

variable "web_acl_arn" {
  description = "Optional WAF web ACL. Arrives with the Phase 11 hardening."
  type        = string
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
