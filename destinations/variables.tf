variable "contacts" {
  type = list(string)
  description = "List of email addresses or webhook urls. Removing items from the middle of this list will require all rule records to be updated. Simply provide an empty string rather than removing an item to avoid this."
}

variable "email" {
  type = string
  description = "Email address from which notifications are sent"
}

variable "rule_sources" {
  type = list(string)
  description = "List of TXT DNS records to query for monitor rules"
}

variable "max_age" {
  type = number
  default = 7
  description = "Maximum days before certificate expiry to send alerts"
}

variable "poll_rate" {
  type = number
  default = 4
  description = "Rate that web services are checked at in minutes"
}
