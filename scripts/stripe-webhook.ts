// Register {BASE_URL}/webhooks/stripe with the Stripe account whose key is in
// .env, and save the endpoint's signing secret back into .env.
//
//   pnpm tsx scripts/stripe-webhook.ts
//
// Run it once per account (once for test mode, again after switching to the
// live key), then restart: systemctl --user restart se-league
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config, ROOT } from '../src/config.js'
import { createWebhookEndpoint, stripeMode } from '../src/lib/stripe.js'

if (!config.stripe.secretKey) { console.error('Set STRIPE_SECRET_KEY in .env first.'); process.exit(1) }
if (!config.baseUrl.startsWith('https://')) { console.error(`BASE_URL must be the public https address (it is ${config.baseUrl}).`); process.exit(1) }
const url = `${config.baseUrl}/webhooks/stripe`
const ep = await createWebhookEndpoint(url)
const file = path.join(ROOT, '.env')
const env = readFileSync(file, 'utf8')
writeFileSync(file, /^STRIPE_WEBHOOK_SECRET=.*$/m.test(env) ? env.replace(/^STRIPE_WEBHOOK_SECRET=.*$/m, `STRIPE_WEBHOOK_SECRET=${ep.secret}`) : `${env}\nSTRIPE_WEBHOOK_SECRET=${ep.secret}\n`)
console.log(`Created ${stripeMode()} webhook ${ep.id} → ${url}`)
console.log('Saved its signing secret to .env. Now: systemctl --user restart se-league')
