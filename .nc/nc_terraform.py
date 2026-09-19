"""Negative controls for the Terraform policy assertions.

The mutations here are the mistakes somebody actually makes: widening a
resource because scoping was fiddly, adding a role to a list because it
seemed harmless, turning off a setting to get a plan to apply.
"""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TF = os.path.join(ROOT, "infra", "terraform")

SECURITY = os.path.join(TF, "modules", "security", "main.tf")
SEC_VARS = os.path.join(TF, "modules", "security", "variables.tf")
NETWORK = os.path.join(TF, "modules", "network", "main.tf")
DATA = os.path.join(TF, "modules", "data", "main.tf")
DATA_VARS = os.path.join(TF, "modules", "data", "variables.tf")
STORAGE = os.path.join(TF, "modules", "storage", "main.tf")
COMPUTE = os.path.join(TF, "modules", "compute", "main.tf")
PROD = os.path.join(TF, "environments", "production", "main.tf")
PROD_VARS = os.path.join(TF, "environments", "production", "variables.tf")

TEST = "packages/testing/test/terraform-policy.isolation.test.ts"

MUTATIONS = [
    # ------------------------------------------------------------- R21
    (SECURITY, "the workspace secret grant is widened to a wildcard",
     '    resources = ["${local.workspace_secrets}-*"]\n  }\n}\n\nresource "aws_iam_role_policy" "workspace_secrets"',
     '    resources = ["*"]\n  }\n}\n\nresource "aws_iam_role_policy" "workspace_secrets"'),

    (SECURITY, "the app secret grant is widened to a wildcard",
     '    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]\n    resources = ["${local.app_secrets}-*"]',
     '    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]\n    resources = ["*"]'),

    (SECURITY, "a secret grant points at somebody else's path",
     'workspace_secrets = "arn:aws:secretsmanager:${local.region}:${local.account}:secret:relayd/${var.environment}/ws/*"',
     'workspace_secrets = "arn:aws:secretsmanager:${local.region}:${local.account}:secret:shared/ws/*"'),

    (SECURITY, "the ARN suffix wildcard is dropped",
     '    resources = ["${local.workspace_secrets}-*"]\n  }\n}\n\nresource "aws_iam_role_policy" "workspace_secrets"',
     '    resources = ["${local.workspace_secrets}"]\n  }\n}\n\nresource "aws_iam_role_policy" "workspace_secrets"'),

    (SECURITY, "the R21 path shape changes",
     'app_secrets       = "arn:aws:secretsmanager:${local.region}:${local.account}:secret:relayd/${var.environment}/app/*"',
     'app_secrets       = "arn:aws:secretsmanager:${local.region}:${local.account}:secret:relayd/app/*"'),

    (SEC_VARS, "the api role is added to the customer credential readers",
     '  default = ["worker", "edge"]',
     '  default = ["api", "worker", "edge"]'),

    (SEC_VARS, "the worker is dropped from the readers, so nothing can send",
     '  default = ["worker", "edge"]',
     '  default = ["edge"]'),

    (SECURITY, "a task is granted iam:PassRole",
     '    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]',
     '    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "iam:PassRole"]'),

    (SECURITY, "a task is granted sts:AssumeRole",
     '    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]',
     '    actions   = ["kms:Decrypt", "kms:GenerateDataKey", "sts:AssumeRole"]'),

    (SECURITY, "an administrator statement appears",
     '  statement {\n    sid       = "WriteOwnLogStream"',
     '  statement {\n    sid       = "Everything"\n    effect    = "Allow"\n    actions   = ["*"]\n    resources = ["*"]\n  }\n\n  statement {\n    sid       = "WriteOwnLogStream"'),

    # -------------------------------------------------------------- R34
    (PROD, "production drops Multi-AZ",
     "  multi_az              = true",
     "  multi_az              = false"),

    (DATA, "a second Redis instance appears",
     'resource "aws_elasticache_replication_group" "this" {',
     'resource "aws_elasticache_replication_group" "rate_limiting" {\n  replication_group_id = "relayd-rl"\n  description = "x"\n}\n\nresource "aws_elasticache_replication_group" "this" {'),

    (COMPUTE, "the Redis keyspace prefix is dropped",
     '          { name = "REDIS_KEY_PREFIX", value = "relayd:${var.environment}:" },',
     '          { name = "REDIS_UNPREFIXED", value = "true" },'),

    (NETWORK, "the Secrets Manager VPC endpoint is removed",
     '    "secretsmanager",\n    "logs",',
     '    "logs",'),

    (NETWORK, "the S3 gateway endpoint is removed",
     'resource "aws_vpc_endpoint" "s3" {',
     'resource "aws_vpc_endpoint" "s3_disabled" {'),

    # ------------------------------------------------------- the data tier
    (NETWORK, "the data tier gets a default route",
     'resource "aws_route_table" "data" {',
     'resource "aws_route" "data_nat" {\n  route_table_id         = aws_route_table.data.id\n  destination_cidr_block = "0.0.0.0/0"\n  nat_gateway_id         = aws_nat_gateway.this[0].id\n}\n\nresource "aws_route_table" "data" {'),

    (NETWORK, "a third port is opened into the data tier",
     'resource "aws_security_group" "data" {',
     'resource "aws_vpc_security_group_ingress_rule" "data_ssh" {\n  security_group_id = aws_security_group.data.id\n  cidr_ipv4         = "10.0.0.0/16"\n  from_port         = 22\n  to_port           = 22\n  ip_protocol       = "tcp"\n}\n\nresource "aws_security_group" "data" {'),

    # ---------------------------------------------------------- storage
    (STORAGE, "a bucket stops blocking public access",
     "  block_public_policy     = true",
     "  block_public_policy     = false"),

    (STORAGE, "image tags become mutable",
     '  image_tag_mutability = "IMMUTABLE"',
     '  image_tag_mutability = "MUTABLE"'),

    (DATA, "the database stops being encrypted",
     "  storage_encrypted     = true",
     "  storage_encrypted     = false"),

    (DATA, "Redis loses transit encryption",
     "  transit_encryption_enabled = true",
     "  transit_encryption_enabled = false"),

    (DATA, "Redis starts evicting keys",
     '    value = "noeviction"',
     '    value = "allkeys-lru"'),

    (DATA_VARS, "backup retention may be set to zero, disabling PITR",
     "    condition     = var.backup_retention_days >= 1",
     "    condition     = var.backup_retention_days >= 0"),

    # -------------------------------------------------------- deployment
    (PROD_VARS, "the image may be a tag rather than a digest",
     '    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image))',
     "    condition     = true"),

    (PROD, "the scheduler is allowed two tasks",
     """    scheduler = {
      cpu           = 512
      memory        = 1024
      desired_count = 1
      max_count     = 1
      singleton     = true""",
     """    scheduler = {
      cpu           = 512
      memory        = 1024
      desired_count = 2
      max_count     = 2
      singleton     = false"""),

    (COMPUTE, "a deploy is allowed to run two schedulers",
     "  deployment_maximum_percent         = each.value.singleton ? 100 : 200",
     "  deployment_maximum_percent         = 200"),

    (COMPUTE, "the target group health-checks /health instead of /ready",
     '    path                = "/ready"',
     '    path                = "/health"'),

    (COMPUTE, "a worker is killed as fast as a web task",
     "      stopTimeout = each.value.path_patterns == null ? 120 : 30",
     "      stopTimeout = 30"),

    (COMPUTE, "the migration task definition disappears",
     'resource "aws_ecs_task_definition" "migrate" {',
     'resource "aws_ecs_task_definition" "migrate_disabled" {'),

    (COMPUTE, "migrations run at container boot",
     '      # One image, four roles. The entrypoint dispatches on this.',
     '      command = ["sh", "-c", "node packages/db/dist/bin/migrate.js && node apps/api/dist/index.js"]\n'),
]


def run():
    return subprocess.run(
        ["node", os.path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
         "run", TEST, "--reporter=basic"],
        cwd=ROOT, capture_output=True, text=True, errors="replace", timeout=300,
    )


def main():
    originals = {path: open(path, encoding="utf-8").read() for path in {m[0] for m in MUTATIONS}}

    baseline = run()
    if baseline.returncode != 0:
        print("BASELINE FAILS")
        print(baseline.stdout[-3000:].encode("ascii", "replace").decode("ascii"))
        return 1

    print("baseline green\n")
    missed = []

    for path, name, old, new in MUTATIONS:
        source = originals[path]
        if source.count(old) != 1:
            print("SKIP    %-58s (anchor matched %d)" % (name, source.count(old)))
            missed.append(name + " [anchor]")
            continue

        open(path, "w", encoding="utf-8", newline="\n").write(source.replace(old, new, 1))
        try:
            verdict = "CAUGHT" if run().returncode != 0 else "MISSED"
        except subprocess.TimeoutExpired:
            verdict = "HANG"
        finally:
            open(path, "w", encoding="utf-8", newline="\n").write(source)

        print("%-7s %s" % (verdict, name))
        if verdict != "CAUGHT":
            missed.append(name)

    print("\n%d/%d caught" % (len(MUTATIONS) - len(missed), len(MUTATIONS)))
    if missed:
        print("MISSED:")
        for m in missed:
            print("  - " + m)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
