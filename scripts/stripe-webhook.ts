// Register {BASE_URL}/webhooks/stripe with a Stripe account and save the endpoint's signing secret into .env.
//
//   pnpm tsx scripts/stripe-webhook.ts          # the test account (STRIPE_SECRET_KEY → STRIPE_WEBHOOK_SECRET)
//   pnpm tsx scripts/stripe-webhook.ts --live   # the live account (STRIPE_LIVE_SECRET_KEY → STRIPE_LIVE_WEBHOOK_SECRET)
//
// Both endpoints point at the same URL; the app accepts either signature. Then restart:
//   systemctl --user restart se-league
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config, ROOT } from '../src/config.js'
import { createWebhookEndpoint, stripeKeys, type StripeMode } from '../src/lib/stripe.js'

const mode: StripeMode = process.argv.includes('--live') ? 'live' : 'test'
const keyVar = mode === 'live' ? 'STRIPE_LIVE_SECRET_KEY' : 'STRIPE_SECRET_KEY'
const secretVar = mode === 'live' ? 'STRIPE_LIVE_WEBHOOK_SECRET' : 'STRIPE_WEBHOOK_SECRET'
if (!stripeKeys()[mode]) { console.error(`Set ${keyVar} in .env first (a ${mode} key).`); process.exit(1) }
if (!config.baseUrl.startsWith('https://')) { console.error(`BASE_URL must be the public https address (it is ${config.baseUrl}).`); process.exit(1) }
const url = `${config.baseUrl}/webhooks/stripe`
const ep = await createWebhookEndpoint(url, mode)
const file = path.join(ROOT, '.env')
const env = readFileSync(file, 'utf8')
const line = new RegExp(`^${secretVar}=.*$`, 'm')
writeFileSync(file, line.test(env) ? env.replace(line, `${secretVar}=${ep.secret}`) : `${env.replace(/\n?$/, '\n')}${secretVar}=${ep.secret}\n`)
console.log(`Created ${mode} webhook ${ep.id} → ${url}`)
console.log(`Saved its signing secret to .env as ${secretVar}. Now: systemctl --user restart se-league`)
