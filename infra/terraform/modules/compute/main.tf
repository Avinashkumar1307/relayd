# ALB and ECS (docs/10 "AWS topology"; CLAUDE.md section 3).
#
# Four process types, one image. `RELAYD_PROCESS` picks the role at run time,
# so staging and production run the identical artifact in four shapes — which
# is what makes "promote the digest" mean anything.
#
# Two of the four take traffic:
#
#   api    /api/*            the dashboard and the public API
#   edge   /o/* /c/* /u/* /ingest/*
#
# docs/10's diagram has three target groups, for `api`, `track` and `ingest`.
# The review merged the last two into one `edge` app (F33), and CLAUDE.md
# section 3 records that, so there are two.
#
# `worker` and `scheduler` take no traffic and have no target group.
# `scheduler` additionally runs as exactly one task — see below, it is the
# only interesting deployment setting in this file.

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
    Module      = "compute"
  })

  # The ALB routes on path. `edge` gets the tracking and ingest prefixes;
  # `api` gets everything under /api. Anything else is a 404 from the
  # listener, so a scanner probing /wp-admin never reaches a task.
  edge_path_patterns = ["/o/*", "/c/*", "/u/*", "/ingest/*"]
}

resource "aws_ecs_cluster" "this" {
  name = "relayd-${var.environment}"
  tags = local.tags

  setting {
    name  = "containerInsights"
    value = var.environment == "production" ? "enabled" : "disabled"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  for_each = var.services

  name              = "/relayd/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = merge(local.tags, { Process = each.key })
}

# ------------------------------------------------------------------ ALB

resource "aws_lb" "this" {
  name               = "relayd-${var.environment}"
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [var.alb_security_group_id]

  # Production only. In staging a stuck delete is worse than an accidental
  # one, because the environment is rebuilt on purpose.
  enable_deletion_protection = var.environment == "production"

  # Longer than the longest legitimate request and shorter than the ALB
  # default of 60s would allow a hung upstream to hold a connection. The send
  # path's 30s provider timeout lives in a worker, not behind this.
  idle_timeout = 65

  drop_invalid_header_fields = true

  access_logs {
    bucket  = var.access_log_bucket
    prefix  = "alb/${var.environment}"
    enabled = var.access_log_bucket != null
  }

  tags = local.tags
}

resource "aws_lb_target_group" "this" {
  for_each = { for name, service in var.services : name => service if service.path_patterns != null }

  name        = "relayd-${var.environment}-${each.key}"
  port        = var.app_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  # `/ready` and not `/health`. docs/10 is explicit about the difference:
  # `/health` is process-alive only and would keep a task in service while it
  # cannot reach Postgres, and `/health/deep` touches providers, which would
  # drain the fleet because somebody else's API is slow.
  health_check {
    path                = "/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # Long enough for an in-flight request to finish, short enough that a deploy
  # is not held open by it.
  deregistration_delay = 30

  tags = merge(local.tags, { Process = each.key })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  # Redirect rather than refuse. A customer typing the hostname without a
  # scheme should land on the app, not on a connection error they read as an
  # outage.
  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  # Nothing matched a rule. A 404 from the listener means a scanner probing
  # for somebody else's admin panel costs us a listener evaluation rather
  # than a request through a task.
  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      message_body = "{\"error\":{\"code\":\"not_found\",\"message\":\"Not found\"}}"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "service" {
  for_each = { for name, service in var.services : name => service if service.path_patterns != null }

  listener_arn = aws_lb_listener.https.arn
  priority     = each.value.listener_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[each.key].arn
  }

  condition {
    path_pattern {
      values = each.value.path_patterns
    }
  }

  tags = merge(local.tags, { Process = each.key })
}

# ------------------------------------------------------- task definitions

resource "aws_ecs_task_definition" "this" {
  for_each = var.services

  family                   = "relayd-${var.environment}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arns[each.key]

  # ARM64 per docs/10 — roughly 20% cheaper per vCPU, and the image is built
  # for it. A mismatch here fails at task start with an exec-format error,
  # which is a confusing way to find out.
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = var.image
      essential = true

      # One image, four roles. The entrypoint dispatches on this.
      environment = concat(
        [
          { name = "RELAYD_PROCESS", value = each.key },
          { name = "NODE_ENV", value = "production" },
          { name = "RELAYD_ENV", value = var.environment },
          { name = "PORT", value = tostring(var.app_port) },
          { name = "AWS_REGION", value = var.region },
          { name = "REDIS_KEY_PREFIX", value = "relayd:${var.environment}:" },
        ],
        [for key, value in var.environment_variables : { name = key, value = value }],
      )

      # Injected by the execution role from Secrets Manager, never baked into
      # the image and never in the task definition in clear.
      secrets = [for key, arn in var.secret_arns : { name = key, valueFrom = arn }]

      portMappings = each.value.path_patterns == null ? [] : [
        { containerPort = var.app_port, protocol = "tcp" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app[each.key].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = each.key
        }
      }

      # Only the services behind the ALB get a container health check. For a
      # worker the ALB is not watching, and a failing check would recycle a
      # task mid-batch for no benefit the task-level restart does not give.
      healthCheck = each.value.path_patterns == null ? null : {
        command     = ["CMD-SHELL", "node -e \"fetch('http://localhost:${var.app_port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }

      # A worker holding a send in flight gets time to finish it. The send
      # path's provider timeout is 30s for an API and 60s for SMTP, so a
      # shorter stop timeout would kill a task mid-provider-call and leave a
      # recipient in the ambiguous state D3 is about.
      stopTimeout = each.value.path_patterns == null ? 120 : 30
    },
  ])

  tags = merge(local.tags, { Process = each.key })
}

# ------------------------------------------------------------- services

resource "aws_ecs_service" "this" {
  for_each = var.services

  name            = each.key
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this[each.key].arn
  desired_count   = each.value.desired_count
  launch_type     = "FARGATE"

  # The scheduler is leader-elected and runs as exactly one task
  # (CLAUDE.md section 3). Two would both tick.
  #
  # `maximum_percent = 100` with `minimum_healthy_percent = 0` is what makes
  # a deploy stop the old task before starting the new one. Every other
  # service is the opposite: 200/100, so a rolling deploy never dips below
  # the running count.
  #
  # The leader election in Postgres would survive a brief overlap, but a
  # deployment that routinely runs two schedulers makes that lock the only
  # thing standing between us and duplicate scheduled sends, and an
  # invariant should not be load-bearing for a configuration choice.
  deployment_maximum_percent         = each.value.singleton ? 100 : 200
  deployment_minimum_healthy_percent = each.value.singleton ? 0 : 100

  # A task that never passes its health check should roll back rather than
  # sit there. Five minutes is longer than a cold start and shorter than a
  # deploy anybody is waiting on.
  health_check_grace_period_seconds = each.value.path_patterns == null ? null : 60

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [var.app_security_group_id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = each.value.path_patterns == null ? [] : [1]

    content {
      target_group_arn = aws_lb_target_group.this[each.key].arn
      container_name   = each.key
      container_port   = var.app_port
    }
  }

  # Spread across AZs before packing. The default binpack would put both
  # production tasks on one AZ and make "min 2 per service, across AZs"
  # (docs/10) true only by luck.
  ordered_placement_strategy {
    type  = "spread"
    field = "attribute:ecs.availability-zone"
  }

  enable_execute_command = var.environment != "production"

  tags = merge(local.tags, { Process = each.key })

  lifecycle {
    # CI updates the task definition with a new image digest. Terraform
    # reconciling it back on the next apply would redeploy whatever was last
    # committed, which is how a rollback gets rolled forward again.
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.https]
}

# ------------------------------------------------------------- autoscaling

resource "aws_appautoscaling_target" "this" {
  for_each = { for name, service in var.services : name => service if !service.singleton && service.max_count > service.desired_count }

  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = each.value.desired_count
  max_capacity       = each.value.max_count
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each = aws_appautoscaling_target.this

  name               = "relayd-${var.environment}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = each.value.service_namespace
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    target_value = 65

    # Scale out quickly, scale in slowly. A queue that spikes wants capacity
    # now; a queue that has drained can afford to keep it for five minutes
    # rather than thrash.
    scale_out_cooldown = 60
    scale_in_cooldown  = 300
  }
}

# --------------------------------------------------- the migration task
#
# CLAUDE.md section 8 and docs/10: migrations run as a one-off ECS task
# before the service update, never at container boot. Twenty tasks booting at
# once would race on the migration table.
#
# Defined here rather than created by CI so the definition is reviewed like
# everything else; CI runs it with `aws ecs run-task`.

resource "aws_ecs_task_definition" "migrate" {
  family                   = "relayd-${var.environment}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = var.execution_role_arn
  # The migration runs as the api role, which holds the application secrets
  # but no customer credential. A migration has no business reading one.
  task_role_arn = var.task_role_arns["api"]

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "migrate"
      image     = var.image
      essential = true

      # An explicit command, which the entrypoint passes through rather than
      # dispatching on RELAYD_PROCESS.
      command = ["node", "packages/db/dist/bin/migrate.js"]

      environment = concat(
        [
          { name = "NODE_ENV", value = "production" },
          { name = "RELAYD_ENV", value = var.environment },
          { name = "AWS_REGION", value = var.region },
        ],
        [for key, value in var.environment_variables : { name = key, value = value }],
      )

      secrets = [for key, arn in var.secret_arns : { name = key, valueFrom = arn }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.migrate.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "migrate"
        }
      }
    },
  ])

  tags = merge(local.tags, { Purpose = "migration" })
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/relayd/${var.environment}/migrate"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = local.tags
}
