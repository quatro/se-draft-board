import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import {
  clearFailures, grantViewer, login, logout, noteFailure, requireAdmin, requireViewer, throttled,
} from '../lib/auth.js'
import * as L from '../lib/league.js'
import { STATUSES } from '../lib/text.js'
import { ignoreRegistration, importRegistrationCsv, linkRegistration, processRegistration, storeRegistration } from '../lib/sportsengine.js'

export const api = Router()
const actor = (req: Request) => req.admin?.username ?? 'unknown'
type H = (req: Request, res: Response) => unknown
const wrap = (fn: H) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = fn(req, res)
    if (!res.headersSent) res.json(out ?? { ok: true })
  } catch (e) {
    if (e instanceof L.UserError || e instanceof z.ZodError) {
      return res.status(400).json({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : e.message })
    }
    next(e)
  }
}

// ---------- session ----------
api.get('/api/me', (req, res) => {
  res.json({ admin: req.admin?.username ?? null, viewer: !!req.viewer, viewerCodeRequired: !!config.viewerPassword })
})
api.post('/api/login', wrap((req, res) => {
  const { username, password } = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body)
  const key = `login:${req.ip}`
  if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' })
  if (!login(res, username, password)) { noteFailure(key); return res.status(401).json({ error: 'Wrong username or password' }) }
  clearFailures(key)
}))
api.post('/api/logout', wrap((req, res) => { logout(req, res) }))
api.post('/api/viewer', wrap((req, res) => {
  const { code } = z.object({ code: z.string() }).parse(req.body)
  const key = `viewer:${req.ip}`
  if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' })
  if (!config.viewerPassword || code.trim() !== config.viewerPassword) { noteFailure(key); return res.status(401).json({ error: 'That code isn’t right' }) }
  clearFailures(key)
  grantViewer(res)
}))

// ---------- live board ----------
api.get('/api/state', requireViewer, (req, res) => { res.json(L.publicState(!!req.admin)) })

api.get('/api/stream', requireViewer, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  const send = (v: number) => res.write(`event: change\ndata: ${v}\n\n`)
  send(L.currentVersion())
  L.bus.on('change', send)
  const ping = setInterval(() => res.write(': ping\n\n'), 25e3)
  req.on('close', () => { clearInterval(ping); L.bus.off('change', send) })
})

api.get('/api/rosters.csv', requireViewer, (_req, res) => {
  const b = L.board()
  const byId = new Map(b.players.map((p) => [p.id, p]))
  const rows: (string | number | null)[][] = [['Team', 'Player', 'Age', 'How acquired', 'Round', 'Pick']]
  for (const t of b.teams) {
    for (const p of b.players.filter((p) => p.kind === 'returning' && p.team_id === t.id && p.status !== 'Not returning')) rows.push([t.name, p.name, p.age, 'Returning', '', ''])
    for (const pk of b.picks.filter((p) => p.team_id === t.id)) { const p = byId.get(pk.player_id); rows.push([t.name, p?.name ?? '', p?.age ?? '', 'Drafted', pk.round, pk.n]) }
  }
  const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''))).join(',')).join('\n')
  res.set('Content-Type', 'text/csv; charset=utf-8')
  res.set('Content-Disposition', `attachment; filename="${b.settings.season || 'draft'}-majors-rosters.csv"`)
  res.send(csv)
})

// ---------- admin ----------
const admin = Router()
admin.use(requireAdmin)
api.use('/api/admin', admin)

const status = z.enum(STATUSES)
const optInt = z.union([z.number().int(), z.null()]).optional()
const playerBody = z.object({
  name: z.string().max(120).optional(),
  age: optInt,
  birthdate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
  kind: z.enum(['returning', 'pool']).optional(),
  teamId: z.union([z.string(), z.null()]).optional(),
  status: status.optional(),
  locked: z.boolean().optional(),
  rank: optInt,
  notes: z.string().max(2000).optional(),
  seProfileId: z.union([z.string().max(100), z.null()]).optional(),
})

admin.post('/pick', wrap((req) => {
  const { playerId, slot } = z.object({ playerId: z.string(), slot: z.string().optional() }).parse(req.body)
  const r = L.makePick(playerId, actor(req), slot)
  return { ok: true, message: `${r.team.name} take ${r.player.name}` }
}))
admin.post('/undo', wrap((req) => { L.undoLast(actor(req)) }))
admin.post('/clock/start', wrap((req) => { L.startClock(actor(req)) }))
admin.post('/picks/clear', wrap((req) => {
  z.object({ confirm: z.literal('CLEAR') }).parse(req.body)
  L.clearPicks(actor(req))
}))
admin.delete('/picks/:slot', wrap((req) => { L.removePick(String(req.params.slot), actor(req)) }))
admin.put('/picks/:slot', wrap((req) => {
  const { playerId } = z.object({ playerId: z.string() }).parse(req.body)
  L.replacePick(String(req.params.slot), playerId, actor(req))
}))

admin.post('/players', wrap((req) => L.upsertPlayer(null, playerBody.extend({ name: z.string().min(1).max(120) }).parse(req.body), actor(req))))
admin.patch('/players/:id', wrap((req) => L.upsertPlayer(String(req.params.id), playerBody.parse(req.body), actor(req))))
admin.delete('/players/:id', wrap((req) => { L.deletePlayer(String(req.params.id), actor(req)) }))
admin.post('/pool/import', wrap((req) => {
  const { text } = z.object({ text: z.string().max(200_000) }).parse(req.body)
  return { added: L.importPool(text, actor(req)) }
}))
admin.get('/players/:id/history', wrap((req) => ({
  audit: db.prepare('SELECT * FROM audit WHERE player_id = ? ORDER BY id DESC LIMIT 100').all(String(req.params.id)),
  registrations: db.prepare('SELECT id, received_at, source, outcome, note FROM registrations WHERE player_id = ? ORDER BY id DESC').all(String(req.params.id)),
})))

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
admin.patch('/settings', wrap((req) => {
  const p = z.object({
    season: z.string().max(20).optional(),
    registrationYear: z.number().int().min(2000).max(2100).optional(),
    rosterSize: z.number().int().min(1).max(30).optional(),
    mode: z.enum(['straight', 'snake']).optional(),
    swap: z.tuple([z.string(), z.string()]).optional(),
    ageCutoff: z.string().regex(/^\d{2}-\d{2}$/).optional(),
  }).parse(req.body)
  L.setSettings(p)
  L.audit(actor(req), 'settings_changed', null, p)
  L.changed()
}))
admin.post('/teams', wrap((req) => { L.saveTeam(null, z.object({ name: z.string(), color, fg: color }).parse(req.body), actor(req)) }))
admin.patch('/teams/:id', wrap((req) => { L.saveTeam(String(req.params.id), z.object({ name: z.string(), color, fg: color }).parse(req.body), actor(req)) }))
admin.delete('/teams/:id', wrap((req) => { L.deleteTeam(String(req.params.id), actor(req)) }))
admin.put('/order', wrap((req) => { L.setOrder(z.object({ order: z.array(z.string()) }).parse(req.body).order, actor(req)) }))

// ---------- registrations inbox ----------
admin.get('/registrations', wrap((req) => {
  const filter = String(req.query.filter ?? 'open')
  const where = filter === 'open' ? `WHERE outcome IN ('unmatched','ambiguous','error','pending')` : filter === 'all' ? '' : `WHERE outcome = ?`
  const args = filter === 'open' || filter === 'all' ? [] : [filter]
  const rows = db.prepare(`SELECT r.id, r.received_at, r.source, r.event_type, r.verified, r.first_name, r.last_name, r.birthdate, r.reg_year,
      r.se_profile_id, r.outcome, r.note, r.player_id, p.name AS player_name
    FROM registrations r LEFT JOIN players p ON p.id = r.player_id ${where} ORDER BY r.id DESC LIMIT 500`).all(...args)
  const counts = Object.fromEntries((db.prepare('SELECT outcome, COUNT(*) n FROM registrations GROUP BY outcome').all() as { outcome: string; n: number }[]).map((r) => [r.outcome, r.n]))
  const se = config.sportsengine
  return {
    rows, counts,
    webhook: {
      configured: !!se.token,
      url: se.token ? `${config.baseUrl}/webhooks/sportsengine/${se.token}` : null,
      signed: !!se.secret,
      signatureHeader: se.signatureHeader,
    },
  }
}))
admin.get('/registrations/:id', wrap((req) => db.prepare('SELECT * FROM registrations WHERE id = ?').get(Number(req.params.id))))
admin.post('/registrations/:id/reprocess', wrap((req) => processRegistration(Number(req.params.id), actor(req))))
admin.post('/registrations/reprocess-open', wrap((req) => {
  const ids = db.prepare(`SELECT id FROM registrations WHERE outcome IN ('unmatched','ambiguous','error','pending')`).all() as { id: number }[]
  const tally: Record<string, number> = {}
  for (const { id } of ids) { const r = processRegistration(id, actor(req)); tally[r.outcome] = (tally[r.outcome] ?? 0) + 1 }
  return tally
}))
admin.post('/registrations/:id/link', wrap((req) => {
  const { playerId } = z.object({ playerId: z.union([z.string(), z.null()]) }).parse(req.body)
  return linkRegistration(Number(req.params.id), playerId, actor(req))
}))
admin.post('/registrations/:id/ignore', wrap((req) => { ignoreRegistration(Number(req.params.id), actor(req)) }))
admin.post('/registrations/import', wrap((req) => {
  const { text } = z.object({ text: z.string().max(2_000_000) }).parse(req.body)
  try { return importRegistrationCsv(text, actor(req)) } catch (e) { throw new L.UserError((e as Error).message) }
}))
// Manual single registration, for testing the matcher or entering a paper form.
admin.post('/registrations/manual', wrap((req) => {
  const b = z.object({ firstName: z.string().min(1), lastName: z.string().min(1), birthdate: z.string().optional(), season: z.string().optional() }).parse(req.body)
  const { id } = storeRegistration('manual', { participant: { first_name: b.firstName, last_name: b.lastName, date_of_birth: b.birthdate }, season: b.season }, true)
  return processRegistration(id, actor(req))
}))

admin.get('/audit', wrap(() => db.prepare(`SELECT a.*, p.name AS player_name FROM audit a LEFT JOIN players p ON p.id = a.player_id ORDER BY a.id DESC LIMIT 300`).all()))
