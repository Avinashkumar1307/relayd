variable "environment" {
  type = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "process_types" {
  description = "One task role per process type (CLAUDE.md section 3)."
  type        = list(string)
  default     = ["api", "edge", "worker", "scheduler"]
}

variable "workspace_secret_readers" {
  description = <<-EOT
    Processes that may read a customer's provider credential, by path prefix.

    `worker` sends email. `edge` verifies an inbound provider webhook against
    that connection's own secret (R4). `api` is deliberately absent: it never
    sends, so an SSRF in a request path yields our configuration rather than
    every customer's SES keys (F21).
  EOT
  type    = list(string)
  default = ["worker", "edge"]
}

variable "workspace_secret_writers" {
  description = <<-EOT
    Processes that may create or rotate a customer's provider credential.

    `api` writes one when a customer connects a provider — writing a secret it
    cannot read back is the correct shape, and is what lets the api role stay
    off the reader list.
  EOT
  type    = list(string)
  default = ["api", "worker"]
}

variable "storage_readers" {
  description = "Processes that touch the uploads and exports buckets."
  type        = list(string)
  default     = ["api", "worker"]
}

variable "product_email_senders" {
  description = "Processes that send our own transactional email through SES."
  type        = list(string)
  default     = ["worker"]
}

variable "product_email_domain" {
  description = "The SES identity for product email. Never a customer's domain."
  type        = string
}

variable "uploads_bucket_arn" {
  type = string
}

variable "exports_bucket_arn" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
