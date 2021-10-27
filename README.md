# Web service monitor

A NodeJS script that monitors webservice availability and their SSL certificate expiry. Monitor rules are specified via
DNS TXT records. The DNS keys (domain names) are provided along with contact information at deploy time. The script has
the following configuration environment variables:

- RULE_SOURCES - Semicolon delimited list of DNS TXT record keys to query for monitor rules
- MAX_AGE - (Default: 7) Number of days before a certificate expires to send notification
- CONTACTS - Semicolon delimited list of email addresses and webhook URLs that can be contacted by monitor rules. If
  removing a contact, leave an empty element in the list to avoid having to update all the contact bitfields.
- FROM - Email address from which notifications are sent
- TEMPLATE - Name of AWS SES Template to use for notifications
- TableName - (Default: MonitorStatus) DynamoDB table name to use for error state persistence
- REGION - AWS region of script deployment and DynamoDB
- ENDPOINT - Optional AWS API endpoint
- MAX_REDIRECTS - (Default: 10) Maximum number of redirects to follow

DNS TXT records containing rules must be of the following format (space separated):

```
timeout retries contact_bitfield url operator content
```

- timeout - Time in seconds before the http/https request times out
- retries - Number of times to reattempt a failed request
- contact_bitfield - base 10 representation of a binary bitfield of the contacts to include in notifications for this
  rule. See below for details.
- url - Full URL to monitor. This must be unique across all rules. You can include
  a [URL fragment](https://en.wikipedia.org/wiki/URI_fragment) if you want to have multiple monitors for the same URL
  where the fragment differs.
- operator - Either '=' or '\~' with an optional '!' prefix to invert the logic. '=' is a simple string match, '\~'
  expects a regular expression.
- content - The content to match against using the specified operator. This can contain spaces.

One rule per record, although you can have multiple TXT records with the same DNS key.

The contact bitfield represents elements in the CONTACTS list, each bit representing an element. The base10 equivalent
would be 2^n for the nth element in the list (the LSB is the first contact, the list is 0 indexed). Each set bit in the
field will have its correlated contact be included in the notification. For example, the decimal value for the rule
record to include the 2nd and 5th contacts would be 2^1 + 2^4 = 18 (0b10010).

Webhook URLs can be included in the CONTACTS list, and those URLs will have the notifications POSTed to them.

## Deployment

Terraform recipes are provided to deploy to either AWS or Docker. See the respective folder in ./destinations for the
modules and ./deployments for example usage of the module.
