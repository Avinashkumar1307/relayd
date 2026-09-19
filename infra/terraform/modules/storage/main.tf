# S3, CloudFront and ECR (docs/10 "AWS topology").
#
# Four buckets, because they have four different lifecycles and one bucket
# with four prefixes would mean one lifecycle rule set and one access policy
# for all of them:
#
#   web       the SPA, private, reached only through CloudFront
#   uploads   customer CSV imports, private, to Infrequent Access at 30 days
#   exports   generated files handed back by presigned URL, deleted at 7 days
#   archive   cold event data, to Glacier Instant Retrieval at 90 days
#
# `exports` expiring is the one that matters most. A presigned URL with a
# seven-day life over an object that lives forever is a link that keeps
# working long after the person who was sent it has left the company.

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
    Module      = "storage"
  })

  buckets = {
    web      = "relayd-${var.environment}-web-${var.account_suffix}"
    uploads  = "relayd-${var.environment}-uploads-${var.account_suffix}"
    exports  = "relayd-${var.environment}-exports-${var.account_suffix}"
    archive  = "relayd-${var.environment}-archive-${var.account_suffix}"
  }
}

resource "aws_s3_bucket" "this" {
  for_each = local.buckets

  bucket = each.value
  tags   = merge(local.tags, { Name = each.value, Purpose = each.key })
}

# Every bucket is private. The web bucket is reached through CloudFront with
# an Origin Access Control, so even it has no public path.
resource "aws_s3_bucket_public_access_block" "this" {
  for_each = local.buckets

  bucket                  = aws_s3_bucket.this[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = local.buckets

  bucket = aws_s3_bucket.this[each.key].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    # Without this every GET is a separate KMS call, which is both a cost and
    # a throttling limit on a bucket that serves a tracking asset.
    bucket_key_enabled = true
  }
}

# Versioning on uploads and archive: docs/10 asks for it, and the reason is
# the accidental-deletion half of the DR plan. Not on exports, which are
# generated and disposable, and not on web, where CloudFront invalidation is
# the rollback.
resource "aws_s3_bucket_versioning" "protected" {
  for_each = toset(["uploads", "archive"])

  bucket = aws_s3_bucket.this[each.value].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.this["uploads"].id

  rule {
    id     = "to-infrequent-access"
    status = "Enabled"

    filter {}

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    # A version nobody has asked for in ninety days is one nobody will.
    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = aws_s3_bucket.this["exports"].id

  rule {
    id     = "expire-with-the-presigned-url"
    status = "Enabled"

    filter {}

    # Seven days, matching the presigned URL lifetime. The object outliving
    # the link is a link that works for somebody who should no longer have it.
    expiration {
      days = 7
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "archive" {
  bucket = aws_s3_bucket.this["archive"].id

  rule {
    id     = "to-glacier-instant-retrieval"
    status = "Enabled"

    filter {}

    # Instant Retrieval rather than Flexible: this is what a support request
    # about a send from eight months ago reads, and a twelve-hour restore
    # turns that into a ticket that stays open overnight.
    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }
  }
}

# --------------------------------------------------------- CloudFront

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "relayd-${var.environment}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Relayd ${var.environment} SPA"
  default_root_object = "index.html"
  price_class         = var.environment == "production" ? "PriceClass_All" : "PriceClass_100"
  aliases             = var.web_aliases
  web_acl_id          = var.web_acl_arn
  tags                = local.tags

  origin {
    domain_name              = aws_s3_bucket.this["web"].bucket_regional_domain_name
    origin_id                = "web"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  default_cache_behavior {
    target_origin_id       = "web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # AWS managed policies rather than hand-rolled ones: CachingOptimized and
    # CORS-S3Origin. Writing our own would be four more things to get subtly
    # wrong for no behaviour we need.
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    origin_request_policy_id   = "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web.id
  }

  # A single-page app serves index.html for any path the router owns. Without
  # these two, a customer who reloads on /campaigns/123 gets S3's XML error
  # document.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn            = var.certificate_arn
    ssl_support_method             = "sni-only"
    minimum_protocol_version       = "TLSv1.2_2021"
    cloudfront_default_certificate = var.certificate_arn == null
  }
}

resource "aws_cloudfront_response_headers_policy" "web" {
  name = "relayd-${var.environment}-web"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    # The SPA talks only to our own API and loads nothing from a third party.
    # `connect-src` names the API origin explicitly rather than 'self',
    # because the API is on a different host.
    content_security_policy {
      content_security_policy = join("; ", [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self'",
        "connect-src 'self' ${var.api_origin}",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ])
      override = true
    }
  }
}

data "aws_iam_policy_document" "web_bucket" {
  statement {
    sid       = "AllowCloudFrontWithOriginAccessControl"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.this["web"].arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    # Scoped to this distribution, so another distribution in the same account
    # cannot serve this bucket.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.this["web"].id
  policy = data.aws_iam_policy_document.web_bucket.json
}

# --------------------------------------------------------------- ECR

resource "aws_ecr_repository" "app" {
  name                 = "relayd"
  image_tag_mutability = "IMMUTABLE"
  tags                 = local.tags

  # Immutable tags matter more than they look. CI promotes a digest through
  # staging to production; a mutable tag means the thing that was tested and
  # the thing that ships can differ while both answer to `:v1.2.3`.

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the last 30 images (docs/10)"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = { type = "expire" }
      },
    ]
  })
}
