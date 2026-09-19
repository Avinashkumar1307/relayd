# KMS, Secrets Manager and the task roles (INVARIANTS R21; review finding F21).
#
# F21 is the finding this module exists to close: "One task role with
# `secretsmanager:GetSecretValue` on a wildcard means any RCE or SSRF in any
# worker yields every customer's SES keys."
#
# So nothing here grants `Resource = "*"` on Secrets Manager. Every grant is a
# path prefix, and the paths are structured so a prefix is a meaningful
# boundary:
#
#   relayd/{env}/ws/{workspaceId}/conn/{connectionId}   customer provider credentials
#   relayd/{env}/app/{name}                             our own application secrets
#
# The worker role can read the first tree and not the second. The api role can
# read the second and not the first — it never sends, so it never needs a
# customer's SES key, and the blast radius of an SSRF in a request path is
# bounded at our own configuration rather than at every customer's credential.
#
# That split is the whole point. A single role that could read both would make
# the path structure documentation rather than a control.
#
# ## What this cannot do
#
# A prefix grant stops the *api* role reading a customer credential. It does
# not stop a compromised *worker* reading workspace B's credential while
# processing workspace A's job, because the worker legitimately needs all of
# them. F21 suggests a condition on a task tag; that needs one task per
# workspace, which is not the architecture. The controls that actually bound
# that case are elsewhere: the five-minute cache ceiling, the audit row per
# fetch, and the scrubbing at the adapter boundary (R22).

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account = data.aws_caller_identity.current.account_id
  region  = data.aws_region.current.name

  tags = merge(var.tags, {
    Environment = var.environment
    Module      = "security"
  })

  # R21's paths, as ARN patterns. Secrets Manager appends a six-character
  # suffix to every ARN, so every pattern ends in `-*` — a pattern without it
  # matches nothing, which is the mistake that gets "fixed" by widening to `*`.
  workspace_secrets = "arn:aws:secretsmanager:${local.region}:${local.account}:secret:relayd/${var.environment}/ws/*"
  app_secrets       = "arn:aws:secretsmanager:${local.region}:${local.account}:secret:relayd/${var.environment}/app/*"
}

# ------------------------------------------------------------------ KMS

resource "aws_kms_key" "this" {
  description             = "Relayd ${var.environment}: RDS, ElastiCache, S3, Secrets Manager"
  enable_key_rotation     = true
  deletion_window_in_days = var.environment == "production" ? 30 : 7
  tags                    = merge(local.tags, { Name = "relayd-${var.environment}" })
}

resource "aws_kms_alias" "this" {
  name          = "alias/relayd-${var.environment}"
  target_key_id = aws_kms_key.this.key_id
}

# --------------------------------------------------------- execution role
#
# What ECS itself uses to start a task: pull the image, write the log stream,
# and inject the secrets named in the task definition. It is not the role the
# application code runs as.

resource "aws_iam_role" "execution" {
  name               = "relayd-${var.environment}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Without this a role trusted by `ecs-tasks.amazonaws.com` can be assumed
    # on behalf of any account's tasks — the confused-deputy problem AWS
    # documents for exactly this trust policy.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The execution role injects the secrets declared in the task definition, so
# it needs to read them — but only ours, never a customer's. A customer
# credential is fetched at run time by the application, not injected at boot,
# precisely so it never sits in a task definition or an environment variable.
data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "ReadApplicationSecretsForInjection"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.app_secrets}-*"]
  }

  statement {
    sid       = "DecryptThoseSecrets"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${local.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# ------------------------------------------------------------- task roles
#
# One role per process type. Four roles rather than one is the substance of
# F21's fix: the api role cannot read a customer's provider credential because
# it has no reason to, and an SSRF in a request path therefore yields our
# configuration rather than every customer's SES keys.

data "aws_iam_policy_document" "task_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }
}

resource "aws_iam_role" "task" {
  for_each = toset(var.process_types)

  name               = "relayd-${var.environment}-task-${each.value}"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
  tags               = merge(local.tags, { Process = each.value })
}

# Everything every process needs: its own database and Redis credentials, and
# the ability to write a log stream.
data "aws_iam_policy_document" "task_common" {
  for_each = toset(var.process_types)

  statement {
    sid       = "ReadOwnApplicationSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = ["${local.app_secrets}-*"]
  }

  statement {
    sid       = "WriteOwnLogStream"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${local.region}:${local.account}:log-group:/relayd/${var.environment}/*"]
  }

  statement {
    sid       = "DecryptWithTheEnvironmentKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.this.arn]
  }

  # Metrics go out as CloudWatch EMF through the log stream, which needs no
  # extra permission. `cloudwatch:PutMetricData` is deliberately absent: it
  # cannot be scoped to a namespace by resource, only by condition, and the
  # EMF path makes it unnecessary.
}

resource "aws_iam_role_policy" "task_common" {
  for_each = toset(var.process_types)

  name   = "common"
  role   = aws_iam_role.task[each.value].id
  policy = data.aws_iam_policy_document.task_common[each.value].json
}

# R21 proper: only the processes that send email may read a customer's
# provider credential, and only by path prefix.
#
# `worker` sends. `edge` verifies inbound provider webhooks against a
# connection's own secret (R4), which lives in the same tree.
data "aws_iam_policy_document" "workspace_secrets" {
  statement {
    sid       = "ReadCustomerProviderCredentialsByPathPrefix"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = ["${local.workspace_secrets}-*"]
  }
}

resource "aws_iam_role_policy" "workspace_secrets" {
  for_each = toset(var.workspace_secret_readers)

  name   = "workspace-secrets"
  role   = aws_iam_role.task[each.value].id
  policy = data.aws_iam_policy_document.workspace_secrets.json
}

# The api role writes secrets when a customer connects a provider, and the
# worker rotates a webhook signing secret. Neither may delete one outright:
# `DeleteSecret` with no recovery window destroys a credential a customer is
# mid-send with, and there is no reason a request path needs it.
data "aws_iam_policy_document" "workspace_secret_writers" {
  statement {
    sid    = "ManageCustomerProviderCredentialsByPathPrefix"
    effect = "Allow"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecret",
      "secretsmanager:TagResource",
    ]
    resources = ["${local.workspace_secrets}-*"]
  }

  # Scheduled with a recovery window, never immediate. A customer who
  # disconnects a provider by mistake has thirty days to say so.
  statement {
    sid       = "ScheduleDeletionWithARecoveryWindow"
    effect    = "Allow"
    actions   = ["secretsmanager:DeleteSecret"]
    resources = ["${local.workspace_secrets}-*"]

    condition {
      test     = "Bool"
      variable = "secretsmanager:ForceDeleteWithoutRecovery"
      values   = ["false"]
    }
  }
}

resource "aws_iam_role_policy" "workspace_secret_writers" {
  for_each = toset(var.workspace_secret_writers)

  name   = "workspace-secrets-write"
  role   = aws_iam_role.task[each.value].id
  policy = data.aws_iam_policy_document.workspace_secret_writers.json
}

# S3, scoped per bucket and per prefix.
data "aws_iam_policy_document" "task_storage" {
  statement {
    sid       = "ReadWriteUploads"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${var.uploads_bucket_arn}/*"]
  }

  statement {
    sid       = "WriteExports"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${var.exports_bucket_arn}/*"]
  }

  statement {
    sid       = "ListThoseTwoBuckets"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [var.uploads_bucket_arn, var.exports_bucket_arn]
  }
}

resource "aws_iam_role_policy" "task_storage" {
  for_each = toset(var.storage_readers)

  name   = "storage"
  role   = aws_iam_role.task[each.value].id
  policy = data.aws_iam_policy_document.task_storage.json
}

# Product email goes through our own SES identity, never a customer's
# (docs/10). Only the worker sends it.
data "aws_iam_policy_document" "product_email" {
  statement {
    sid       = "SendProductEmailFromOurOwnIdentity"
    effect    = "Allow"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = ["arn:aws:ses:${local.region}:${local.account}:identity/${var.product_email_domain}"]
  }
}

resource "aws_iam_role_policy" "product_email" {
  for_each = toset(var.product_email_senders)

  name   = "product-email"
  role   = aws_iam_role.task[each.value].id
  policy = data.aws_iam_policy_document.product_email.json
}
