import express from 'express'
import path from 'node:path'
import { config, isProd, ROOT } from './config.js'
import './db.js'
import { loadAuth } from './lib/auth.js'
import { runPlans } from './lib/plans.js'
import { api } from './routes/api.js'
import { register, stripeWebhook } from './routes/register.js'
import { webhookRouter } from './routes/webhooks.js'

const app = express()
app.set('trust proxy', 1)
app.disable('x-powered-by')

app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.set('X-Frame-Options', 'DENY')
  if (isProd && config.baseUrl.startsWith('https')) res.set('Strict-Transport-Security', 'max-age=31536000')
  next()
})

// Webhooks read the raw body for signature checks, so they mount before the JSON parser.
app.use(webhookRouter)
app.use(stripeWebhook)
app.use(express.json({ limit: '4mb' }))
app.use(loadAuth)

app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }) })
app.use(api)
app.use(register)

const page = (name: string) => (_req: express.Request, res: express.Response) => res.sendFile(path.join(ROOT, 'public', name))
// A draft-room hostname (e.g. 2027majordraft...) opens straight into its draft; /admin there is that room's admin view.
app.get(['/', '/admin'], (req, res, next) => (config.draftHosts[req.hostname] ? page('draft.html')(req, res) : next()))
app.get(['/draft/:season/:key', '/draft/:season/:key/admin'], page('draft.html'))
app.get(['/admin', '/kids/:id', '/coach'], page('index.html'))
app.get(['/register/:slug', '/register/:slug/done'], page('register.html'))
app.get('/signin', page('signin.html'))
app.get('/interest/:token', page('interest.html'))
app.use(express.static(path.join(ROOT, 'public'), { maxAge: 0, extensions: ['html'] }))

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)
  res.status(500).json({ error: 'Something went wrong' })
})

app.listen(config.port, '127.0.0.1', () => console.log(`${config.leagueName} league app on http://127.0.0.1:${config.port}`))

// Payment plans: charge what's due and send the "coming up" reminders. Every 15 minutes, first run a minute after start.
const planTick = () => runPlans().catch((e) => console.error('[plans]', e))
setTimeout(planTick, 60_000)
setInterval(planTick, 15 * 60_000)
// Opening day: once registration opens to everyone, charge and register the early sign-ups. Checked every minute.
