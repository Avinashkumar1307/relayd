output "bucket_names" {
  value = { for key, bucket in aws_s3_bucket.this : key => bucket.id }
}

output "bucket_arns" {
  value = { for key, bucket in aws_s3_bucket.this : key => bucket.arn }
}

output "uploads_bucket_arn" {
  value = aws_s3_bucket.this["uploads"].arn
}

output "exports_bucket_arn" {
  value = aws_s3_bucket.this["exports"].arn
}

output "web_bucket_name" {
  value = aws_s3_bucket.this["web"].id
}

output "cloudfront_distribution_id" {
  description = "Needed by CI to invalidate after a web deploy."
  value       = aws_cloudfront_distribution.web.id
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.web.domain_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "ecr_repository_arn" {
  value = aws_ecr_repository.app.arn
}
