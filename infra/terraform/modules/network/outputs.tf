output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr" {
  value = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "app_subnet_ids" {
  description = "Private with NAT egress. Every ECS task runs here."
  value       = aws_subnet.app[*].id
}

output "data_subnet_ids" {
  description = "No route to the internet. RDS and ElastiCache only."
  value       = aws_subnet.data[*].id
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "app_security_group_id" {
  value = aws_security_group.app.id
}

output "data_security_group_id" {
  value = aws_security_group.data.id
}

output "availability_zones" {
  value = local.azs
}
