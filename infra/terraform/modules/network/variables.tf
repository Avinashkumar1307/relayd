variable "environment" {
  description = "staging or production. Appears in every resource name and tag."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "vpc_cidr" {
  description = "The VPC range. docs/10 uses 10.0.0.0/16."
  type        = string
  default     = "10.0.0.0/16"
}

variable "app_port" {
  description = "The port ECS tasks listen on."
  type        = number
  default     = 3000
}

variable "nat_gateway_per_az" {
  description = <<-EOT
    One NAT gateway per availability zone.

    True in production: it removes a cross-AZ data charge and a single point of
    failure. False in staging, where halving a fixed hourly cost matters more
    than the availability of an environment that can be rebuilt (F34).
  EOT
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
