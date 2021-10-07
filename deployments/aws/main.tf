provider "aws" {
  region = var.region
}

module "monitor" {
  source = "../../destinations/aws"
  contacts = ["nolan_w@sfu.ca"]
  email = var.email
  rule_sources = ["_monitors.brinkmanlab.ca"]
  poll_rate = 1
}
