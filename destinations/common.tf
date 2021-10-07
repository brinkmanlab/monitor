locals {
  contact_bits = {for i,c in var.contacts: c=>pow(2, i) }
  contacts = join(";", var.contacts)
  rule_sources = join(";", var.rule_sources)

  config = {
    REGION = data.aws_region.region.name
    RULE_SOURCES = local.rule_sources
    MAX_AGE = var.max_age
    CONTACTS = local.contacts
    FROM = var.email
    TEMPLATE = aws_ses_template.notification.name
  }
}
