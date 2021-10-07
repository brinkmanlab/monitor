locals {
  source_path = "${path.module}/../../monitor.zip"
}

resource "aws_dynamodb_table" "MonitorStatus" {
  name           = "MonitorStatus"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "url"

  attribute {
    name = "url"
    type = "S"
  }
}

resource "aws_ses_template" "notification" {
  name    = "MonitorNotification"
  subject = "Web service monitor event"
  text    = <<EOF
The following events occurred while polling the configured web services:
{{ERRORS}}
EOF
}

data "aws_iam_policy_document" "lambda" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      identifiers = ["lambda.amazonaws.com"]
      type = "Service"
    }
    effect = "Allow"
  }
}

resource "aws_iam_role" "monitor" {
  name_prefix = "monitor"
  assume_role_policy = data.aws_iam_policy_document.lambda.json
}

data "aws_iam_policy_document" "monitor" {
  statement {
    actions = ["ses:SendEmail","ses:SendTemplatedEmail"]
    resources = ["*"]
    condition {
      test = "StringEquals"
      values = [var.email]
      variable = "ses:FromAddress"
    }
    effect = "Allow"
  }
  statement {
    actions = [
      #"dynamodb:BatchGet*",
      #"dynamodb:DescribeStream",
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      #"dynamodb:BatchWrite*",
      #"dynamodb:CreateTable",
      "dynamodb:DeleteItem",
      "dynamodb:UpdateItem",
      "dynamodb:PutItem",
    ]
    resources = [aws_dynamodb_table.MonitorStatus.arn]
    effect = "Allow"
  }
}

resource "aws_iam_role_policy" "monitor" {
  role = aws_iam_role.monitor.id
  policy = data.aws_iam_policy_document.monitor.json
}

data "aws_iam_policy" "AWSLambdaBasicExecutionRole" {
  name = "AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "AWSLambdaBasicExecutionRole" {
  role = aws_iam_role.monitor.id
  policy_arn = data.aws_iam_policy.AWSLambdaBasicExecutionRole.arn
}

data "aws_region" "region" {}

resource "aws_lambda_function" "monitor" {
  function_name = "monitor"
  description   = "Monitors web services and their certificate expiry"
  filename      = local.source_path
  source_code_hash = filebase64sha256(local.source_path)
  role          = aws_iam_role.monitor.arn
  handler       = "index.poll"
  architectures = ["arm64"]
  runtime       = "nodejs14.x"
  timeout       = 120

  reserved_concurrent_executions = 1

  environment {
    variables = local.config
  }
}

data "aws_iam_policy_document" "eventbridge" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      identifiers = ["events.amazonaws.com"]
      type = "Service"
    }
    effect = "Allow"
  }
}

resource "aws_iam_role" "trigger" {
  name_prefix = "monitor_trigger"
  assume_role_policy = data.aws_iam_policy_document.eventbridge.json
}

data "aws_iam_policy_document" "trigger" {
  statement {
    actions = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.monitor.arn]
    effect = "Allow"
  }
}

resource "aws_iam_role_policy" "trigger" {
  role = aws_iam_role.trigger.id
  policy = data.aws_iam_policy_document.trigger.json
}

resource "aws_cloudwatch_event_rule" "monitor" {
  name_prefix = "monitor"
  schedule_expression = "rate(${var.poll_rate} minute${var.poll_rate == 1 ? "" : "s"})"
  description = "Triggers webservice monitor at regular intervals"
  role_arn = aws_iam_role.trigger.arn
}

resource "aws_cloudwatch_event_target" "monitor" {
  rule      = aws_cloudwatch_event_rule.monitor.name
  arn       = aws_lambda_function.monitor.arn
  retry_policy {
    maximum_retry_attempts = 1
    maximum_event_age_in_seconds = 60
  }
}
