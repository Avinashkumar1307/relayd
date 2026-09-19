output "alb_dns_name" {
  value = module.compute.alb_dns_name
}

output "cloudfront_domain_name" {
  value = module.storage.cloudfront_domain_name
}

output "cloudfront_distribution_id" {
  description = "CI invalidates this after a web deploy."
  value       = module.storage.cloudfront_distribution_id
}

output "ecr_repository_url" {
  value = module.storage.ecr_repository_url
}

output "cluster_name" {
  value = module.compute.cluster_name
}

output "service_names" {
  value = module.compute.service_names
}

output "migrate_task_definition_family" {
  value = module.compute.migrate_task_definition_family
}

output "app_subnet_ids" {
  description = "CI needs these to run the one-off migration task."
  value       = module.network.app_subnet_ids
}

output "app_security_group_id" {
  value = module.network.app_security_group_id
}

output "web_bucket_name" {
  value = module.storage.web_bucket_name
}

output "db_master_secret_arn" {
  value     = module.data.db_master_secret_arn
  sensitive = true
}

output "paging_alarm_names" {
  value = module.observability.alarm_names
}
