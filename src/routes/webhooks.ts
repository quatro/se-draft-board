import express, { Router } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { processRegistration, storeRegistration, verifySignature } from '../lib/sportsengine.js'

export const webhookRouter = Router()

const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

// POST /webhooks/sportsengine/:token
// Raw body so the HMAC is computed over exactly what SportsEngine signed.
webhookRouter.post('/webhooks/sportsengine/:token', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const se = config.sportsengine
  if (!se.token) return res.status(503).json({ error: 'webhook not configured' })
  if (!sameToken(String(req.params.token), se.token)) return res.status(404).end()

  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  let verified = false
  if (se.secret) {
    verified = verifySignature(raw, req.get(se.signatureHeader), se.secret)
    if (!verified) return res.status(401).json({ error: 'bad signature' })
  }
  let payload: unknown
  try { payload = JSON.parse(raw.toString('utf8')) } catch { return res.status(400).json({ error: 'expected JSON' }) }

  // Some senders batch events in an array; treat each as its own registration.
  const events = Array.isArray(payload) ? payload : [payload]
  const results = events.map((ev) => {
    const { id, duplicate } = storeRegistration('webhook', ev, verified)
    if (duplicate) return { id, duplicate: true }
    try { return { id, ...processRegistration(id) } } catch (e) {
      console.error('[sportsengine] processing failed', id, e)
      return { id, outcome: 'error' }
    }
  })
  res.json({ received: results.length, results })
})
