const https = require('https');
const http = require('http');
const dns = require('dns');

const AWS = require('aws-sdk');
AWS.config.update({
    region: process.env.REGION,
    endpoint: process.env.ENDPOINT, // dynamodb has local deployments available
});
const SES = new AWS.SES({apiVersion: '2010-12-01'});

const RULE_SOURCES = process.env.RULE_SOURCES.split(';')
const MAX_AGE = parseInt(process.env.MAX_AGE || "7") * 1000 * 60 * 60 * 24
const CONTACTS = process.env.CONTACTS.split(';').map(c=>c.trim())
if (CONTACTS.length >= Math.log2(Number.MAX_SAFE_INTEGER)) console.error("There are more contacts than bits available in max number")
const FROM = process.env.FROM
const TEMPLATE = process.env.TEMPLATE
const TableName = process.env.TABLE_NAME || "MonitorStatus"
const MAX_REDIRECTS = process.env.MAX_REDIRECTS || 10

// Rule record format (space separated): timeout(seconds) retries contact_bitfield url operator content
// 4kb max for TXT record ( depending on dns server )

const docClient = new AWS.DynamoDB.DocumentClient()
async function handleState (data) {
    if (data.$response.hasNextPage()) {
        return data.Items.concat(await data.$response.nextPage().promise().then(handleState))
    } else {
        return data.Items
    }
}
const state = docClient.scan({TableName, Select: "ALL_ATTRIBUTES"}).promise().then(handleState).then(items=>new Map(items.map(i=>[i.url, i])))

/**
 * Get list of messages to send to user based on result
 * This function assumes that the rule is in a error state transition
 * @param result {{rule: object, timeout: boolean, content: boolean, expiring: boolean, code: number, error: string}} result of checking rule
 * @param duration {number} seconds that the rule was in error state or 0
 */
function getMessages(result, duration) {
    const messages = []
    const rule = result.rule
    if (result.code !== 0) messages.push(`FAIL: ${rule.url} returned code ${result.code}`)
    if (result.timeout) messages.push(`FAIL: ${rule.url} timed out`)
    if (result.error) messages.push(`FAIL: The request to ${rule.url} failed with: ${result.error}`)
    if (!result.content && (result.code !== 0 || result.timeout || result.error)) return messages;

    let downtime = Math.floor(duration / (24 * 60 * 60)) + "d "
    duration %= 24 * 60 * 60
    downtime += Math.floor(duration / (60 * 60)) + "h "
    duration %= 60 * 60
    downtime += Math.floor( duration / 60) + "m "
    duration %= 60
    downtime += duration + "s"
    switch (rule.operator) {
        case '=':
            messages.push(result.content
                ? `FAIL: The content of ${rule.url} did not include "${rule.content}"`
                : `PASS: ${rule.url} is responding and confirmed to include "${rule.content}" (Downtime: ${downtime})`
            )
            break
        case '!=':
            messages.push(result.content
                ? `FAIL: The content of ${rule.url} included "${rule.content}"`
                : `PASS: ${rule.url} is responding and confirmed to not include "${rule.content}" (Downtime: ${downtime})`
            )
            break
        case '~':
            messages.push(result.content
                ? `FAIL: The content of ${rule.url} did not match "${rule.content}"`
                : `PASS: ${rule.url} is responding and confirmed to match "${rule.content}" (Downtime: ${downtime})`
            )
            break
        case '!~':
            messages.push(result.content
                ? `FAIL: The content of ${rule.url} matched "${rule.content}"`
                : `PASS: ${rule.url} is responding and confirmed to not match "${rule.content}" (Downtime: ${downtime})`
            )
            break
        default:
            messages.push(`The rule for ${rule.url} refers to an unsupported operator ${rule.operator}`)
    }
    return messages
}

/**
 * Helper to update the stored state of failed rules
 * @param url {string} url of rule
 * @param time {number} milliseconds since epoc that the error was first detected
 * @param expiring {boolean} true if the certificate will expire soon
 * @return {Promise<void>}
 */
async function setState(url, time, expiring) {
    // TODO this assumes that there is only one rule per url, that might be ok but we need to test if url fragments can be included to distinguish
    const s = await state
    try {
        if (time === 0 && !expiring) {
            await docClient.delete({TableName, Key: {url}}).promise()
            s.delete(url)
        } else {
            await docClient.put({TableName, Item: {url, time, expiring}}).promise()
            s.set(url, {time, expiring})
        }
    } catch (e) {
        console.error(e)
    }
}


/**
 * Helper to send emails
 * @param addresses {string[]} array of email addresses
 * @param body {string} body to include in email
 */
function sendMail(addresses, body) {
    // TODO add smtp config and if provided use https://nodemailer.com/about/
    SES.sendTemplatedEmail({
        Destination: {
            ToAddresses: addresses,
        },
        ConfigurationSetName: "rendering_failure_event",
        Source: FROM,
        Template: TEMPLATE,
        TemplateData: JSON.stringify({ERRORS: body}),
    }).on('error', resp=>console.error(resp)).send()
}

/**
 * Helper to make webhook requests
 * @param urls {string[]} array of urls to POST to
 * @param body {string} body of POST request
 */
function sendWebhooks(urls, body) {
    for (const url in urls) {
        const req = (url.startsWith("https://") ? https : http).request(url, {method: "POST"})
        req.on('error', console.error)
        req.write(body)
        req.end()
    }
}

/**
 * Helper to parse TXT DNS records containing rules
 * @param raw_rules {string[][]} array of TXT records as returned by dns.resolveTXT
 * @return {{timeout: number, retries: number, contact_bitfield: number, url: string, operator: string, content: string}[]}
 */
function parseRules(raw_rules) {
    const rules = [];
    for (const rule of raw_rules) {
        let [timeout, retries, contact_bitfield, url, operator, ...content] = rule.join('').split(' ')
        timeout = parseInt(timeout) * 1000
        contact_bitfield = parseInt(contact_bitfield)  // contact_bitfield.match('^[0-9]+$') ? parseInt(contact_bitfield) : atob(contact_bitfield)  //TODO replace with https://github.com/i5ik/Uint1Array to allow more than ~58 contacts
        rules.push({timeout, retries, contact_bitfield, url, operator, content: content.join(' ')})
    }
    return rules;
}

/**
 * Makes request and handles response
 * @param url {string} URL of request
 * @param rule {{url: string, time: number, expiring: boolean, operator: string}} rule that is being checked
 * @param max_age {number} The maximum remaining time before a certificate expires in days
 * @param result {rule: object, timeout: boolean, content: boolean, expiring: boolean, code: number, error: string, retries: number} result object to resolve
 * @param resolve {Function} callback to resolve result
 * @param retries {number}
 * @param redirects {number}
 */
function get(url, rule, max_age, result, resolve, retries, redirects) {
    (url.startsWith('https') ? https : http).get(url, function (res) {
        // Check return code
        if (res.statusCode >= 300 && res.statusCode < 400) {
            // Handle redirect
            if (Number.isInteger(redirects) && redirects > MAX_REDIRECTS) {
                result.error = "too many redirects"
                resolve(result)
                return;
            }
            if (url === res.headers.location) {
                result.error = "redirect loop"
                resolve(result)
                return
            }
            get(res.headers.location, rule, max_age, result, resolve, retries, (redirects || 0) + 1)
            return
        }

        if (res.statusCode < 200 || res.statusCode >= 400) {
            result.code = res.statusCode
            resolve(result)
            return
        }

        if (rule.url.startsWith('https')) {
            // Check cert expiry
            res.socket.on('connect', () => {
                // This should always occur before the 'end' event (hopefully)
                const raw_valid_to = res.socket.getPeerCertificate().valid_to
                const valid_to = Date.parse(raw_valid_to)
                if (isNaN(valid_to)) console.error(`Couldn't parse certificate expiry for ${rule.url}: ${raw_valid_to}`, res.socket.getPeerCertificate())
                else result.expiring = valid_to - Date.now() < max_age;
            })
        }

        //Check body content
        let body = ''
        res.on('data', (chunk)=>{
            body += chunk
        })
        res.on("end", ()=>{
            let fail_value = false
            let operator = rule.operator
            if (operator.startsWith('!')) {
                fail_value = true
                operator = operator.slice(1)
            }
            switch (operator) {
                case '=':
                    result.content = fail_value === body.includes(rule.content)
                    break
                case '~':
                    result.content = fail_value === (body.match(rule.content) === null)
                    break
                default:
                    result.content = true
            }
            resolve(result)
        })
    }).setTimeout(rule.timeout,function () {
        if (retries <= 0) {
            result.timeout = true
            resolve(result)
        } else {
            get(url, rule, max_age, result, resolve, retries-1, redirects)
        }
    }).on('error', err=>{
        if (retries <= 0) {
            result.error = err
            resolve(result)
        } else {
            get(url, rule, max_age, result, resolve, retries-1, redirects)
        }
    });
}

/**
 * Check that the url passes the rules criteria
 * @param rule {{url: string, time: number, expiring: boolean, retries: number}} rule to evaluate
 * @param max_age {number} The maximum remaining time before a certificate expires in days
 * @return {Promise<{rule: object, timeout: boolean, content: boolean, expiring: boolean, code: number, error: string, retries: number}>}
 */
function check(rule, max_age) {
    return new Promise(resolve=>{
        const result = {rule, timeout: false, content: false, expiring: false, code: 0, error: ""};
        get(rule.url, rule, max_age, result, resolve, rule.retries || 0, 0)
    })
}

function main(rule_sources, max_age, contacts) {
    for (const source of rule_sources) {
        dns.resolveTxt(source, function (err, raw_rules) {
            if (err != null) {
                console.error(`Error fetching rules from ${source}`)
                return
            }
            const rules = parseRules(raw_rules)
            Promise.all(rules.map(rule=>check(rule, max_age))).then(async results=>{
                const contact_message = new Map()
                for (const result of results) {
                    const {time, expiring} = (await state).get(result.rule.url) || {time: 0, expiring: false}
                    const error = result.timeout || result.content || result.code !== 0 || !!result.error
                    if ((time !== 0 || expiring) === error) continue  // Not entering or exiting error state, all is good, skip
                    let new_time = time
                    if (time !== 0 && !error) new_time = 0
                    else if (time === 0 && error) new_time = Date.now()
                    if (((time === 0) === error) || expiring !== result.expiring) setState(result.rule.url, new_time, expiring)
                    const messages = getMessages(result, Math.floor((Date.now() - time) / 1000))
                    // Map results to contacts
                    let bitfield = result.rule.contact_bitfield
                    for (let i = 0; bitfield; ++i) {
                        if (bitfield & 1) {
                            const contact = contacts[i]
                            if (!contact) continue
                            let message = contact_message.get(contact)
                            if (message === undefined) {
                                message = []
                                contact_message.set(contact, message)
                            }
                            message.push(messages)
                        }
                        bitfield >>= 1
                    }
                }
                return contact_message
            }).then((messages)=>{
                for ( const [address, errors] of messages.entries()) {
                    const body = errors.flat().join('\r\n')
                    if (address.startsWith("https://") || address.startsWith("http://")) {
                        sendWebhooks(address, body)
                    } else {
                        sendMail([address], body) // TODO BCC all addresses with the same body to reduce the number of SES requests
                    }
                }
            });
        });
    }
}

exports.poll = (event, context, callback) => {
    main(RULE_SOURCES, MAX_AGE, CONTACTS)
}

exports.status = (event, context, callback) => {
    // TODO dump state variable as html, include rules.url as "UP"
}
