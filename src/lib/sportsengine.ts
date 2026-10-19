import { createHmac, timingSafeEqual } from 'node:crypto'
import { db } from '../db.js'
import { audit, changed, getSettings, type Player } from './league.js'
import { leagueAge, nameKey, normDate, parseCsv, uid } from './text.js'

// SportsEngine registration intake.
//
// We don't have SportsEngine's webhook schema yet, so extract() is deliberately
// tolerant: it walks the payload for the usual spellings of first/last name,
// birthdate, profile id and season. Every delivery is stored raw first, so once
// real payloads arrive the mapping can be tightened and the inbox replayed from
// /admin without asking SportsEngine to resend anything.

export interface Extracted {
  eventId: string | null
  eventType: string | null
  firstName: string | null
  lastName: string | null
  birthdate: string | null
  regYear: number | null
  seProfileId: string | null
  seRegistrationId: string | null
  cancelled: boolean
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '')

const FIRST = ['firstname', 'first', 'givenname', 'participantfirstname', 'playerfirstname', 'athletefirstname']
const LAST = ['lastname', 'last', 'familyname', 'surname', 'participantlastname', 'playerlastname', 'athletelastname']
const FULL = ['fullname', 'name', 'participantname', 'playername', 'athletename']
const DOB = ['dateofbirth', 'dob', 'birthdate', 'birthday', 'birthdt', 'participantdob', 'playerdob']
const PROFILE = ['profileid', 'personid', 'participantid', 'athleteid', 'playerid', 'personaid', 'userid']
const REGID = ['registrationresultid', 'registrationid', 'resultid', 'submissionid', 'orderid']
const YEAR = ['season', 'seasonname', 'registrationyear', 'year', 'seasonyear']
const LABEL = ['registrationname', 'formname', 'programname', 'surveyname', 'title', 'name', 'season', 'seasonname']
const PERSON_KEYS = ['participant', 'player', 'athlete', 'registrant', 'profile', 'person', 'child', 'member']

function walk(o: unknown, fn: (k: string, v: unknown, path: string[]) => void, path: string[] = [], depth = 0) {
  if (depth > 8) return
  if (Array.isArray(o)) o.forEach((v, i) => walk(v, fn, [...path, String(i)], depth + 1))
  else if (isObj(o)) for (const [k, v] of Object.entries(o)) { fn(k, v, path); walk(v, fn, [...path, k], depth + 1) }
}

function scalar(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number') return String(v)
  return null
}

/** First value under any of `keys`, preferring ones nested under a person-like object. */
function find(payload: unknown, keys: string[]): string | null {
  let best: { v: string; score: number } | null = null
  walk(payload, (k, v, path) => {
    const s = scalar(v)
    if (!s) return
    const i = keys.indexOf(norm(k))
    if (i < 0) return
    const person = path.some((p) => PERSON_KEYS.includes(norm(p))) ? 0 : 100
    const guardian = path.some((p) => /guardian|parent|contact|billing|purchaser|account/.test(norm(p))) ? 1000 : 0
    const score = guardian + person + i + path.length
    if (!best || score < best.score) best = { v: s, score }
  })
  return (best as { v: string } | null)?.v ?? null
}

export function extract(payload: unknown): Extracted {
  let firstName = find(payload, FIRST)
  let lastName = find(payload, LAST)
  if (!firstName || !lastName) {
    const full = find(payload, FULL)
    if (full && /\s/.test(full)) {
      const parts = full.split(/\s+/)
      firstName ??= parts.slice(0, -1).join(' ')
      lastName ??= parts.at(-1)!
    }
  }
  let regYear: number | null = null
  const y = find(payload, YEAR)
  if (y && /^(20\d\d)$/.test(y)) regYear = +y
  if (!regYear) {
    for (const k of [...YEAR, ...LABEL]) {
      const m = /\b(20\d\d)\b/.exec(find(payload, [k]) ?? '')
      if (m) { regYear = +m[1]!; break }
    }
  }
  const eventType = find(payload, ['type', 'event', 'eventtype', 'topic', 'action'])
  return {
    eventId: isObj(payload) ? scalar(payload.id) ?? scalar(payload.event_id) ?? scalar(payload.eventId) ?? null : null,
    eventType,
    firstName, lastName,
    birthdate: normDate(find(payload, DOB)),
    regYear,
    seProfileId: find(payload, PROFILE),
    seRegistrationId: find(payload, REGID),
    cancelled: /cancel|withdraw|refund|delete|void/i.test(eventType ?? ''),
  }
}

export function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false
  const given = header.replace(/^sha256=/i, '').trim()
  const mac = createHmac('sha256', secret).update(raw)
  const hex = mac.digest('hex')
  const b64 = Buffer.from(hex, 'hex').toString('base64')
  for (const want of [hex, b64]) {
    const a = Buffer.from(given), b = Buffer.from(want)
    if (a.length === b.length && timingSafeEqual(a, b)) return true
  }
  return false
}

// ---------- matching ----------
export type Outcome = 'matched' | 'unmatched' | 'ambiguous' | 'wrong_year' | 'locked' | 'ignored' | 'error'

export function matchPlayer(x: Pick<Extracted, 'firstName' | 'lastName' | 'birthdate' | 'seProfileId'>): { player?: Player; outcome: Outcome; note: string } {
  if (x.seProfileId) {
    const p = db.prepare('SELECT * FROM players WHERE se_profile_id = ?').get(x.seProfileId) as Player | undefined
    if (p) return { player: p, outcome: 'matched', note: 'by SportsEngine id' }
  }
  if (!x.firstName || !x.lastName) return { outcome: 'unmatched', note: 'no participant name found in payload' }
  const key = nameKey(`${x.firstName} ${x.lastName}`)
  let cands = db.prepare('SELECT * FROM players WHERE name_key = ?').all(key) as Player[]
  if (x.birthdate && cands.length) {
    const sameDob = cands.filter((c) => !c.birthdate || c.birthdate === x.birthdate)
    if (!sameDob.length) return { outcome: 'unmatched', note: `name matches ${cands[0]!.name} but birthdate differs` }
    cands = sameDob
  }
  if (cands.length === 1) return { player: cands[0]!, outcome: 'matched', note: 'by name' }
  if (cands.length > 1) return { outcome: 'ambiguous', note: `${cands.length} players named ${x.firstName} ${x.lastName}` }
  return { outcome: 'unmatched', note: 'no player with that name' }
}

/** Apply a registration to its player. Locked statuses and "Not returning" are never overwritten. */
function apply(regId: number, p: Player, x: Extracted, actor: string): { outcome: Outcome; note: string } {
  const to = x.cancelled ? 'Not registered' : 'Registered'
  db.prepare(`UPDATE players SET se_profile_id = COALESCE(se_profile_id, ?), se_registration_id = COALESCE(?, se_registration_id),
    birthdate = COALESCE(birthdate, ?), updated_at = datetime('now') WHERE id = ?`)
    .run(x.seProfileId && !db.prepare('SELECT 1 FROM players WHERE se_profile_id = ? AND id <> ?').get(x.seProfileId, p.id) ? x.seProfileId : null,
      x.seRegistrationId, x.birthdate, p.id)
  db.prepare('UPDATE registrations SET player_id = ? WHERE id = ?').run(p.id, regId)
  if (p.status_locked) return { outcome: 'locked', note: `status locked at "${p.status}" by an admin — not changed` }
  // Flipping a "Not returning" player back changes how many picks their team owes,
  // possibly mid-draft, so that one is left for an admin to decide.
  if (p.status === 'Not returning') return { outcome: 'locked', note: 'player is marked Not returning — review and change by hand' }
  if (p.status === to) return { outcome: 'matched', note: `already ${to}` }
  db.prepare(`UPDATE players SET status = ?, status_source = 'sportsengine', registered_at = CASE WHEN ? = 'Registered' THEN datetime('now') ELSE NULL END,
    updated_at = datetime('now') WHERE id = ?`).run(to, to, p.id)
  audit(actor, 'status_from_sportsengine', p.id, { from: p.status, to, registration: regId })
  return { outcome: 'matched', note: `${p.status} → ${to}` }
}

export function processRegistration(regId: number, actor = 'sportsengine'): { outcome: Outcome; note: string; playerId?: string } {
  const r = db.prepare('SELECT * FROM registrations WHERE id = ?').get(regId) as { raw: string; source: string } | undefined
  if (!r) throw new Error('no such registration')
  let x: Extracted
  try { x = extract(JSON.parse(r.raw)) } catch (e) {
    db.prepare(`UPDATE registrations SET outcome = 'error', note = ? WHERE id = ?`).run(String(e), regId)
    return { outcome: 'error', note: String(e) }
  }
  db.prepare(`UPDATE registrations SET event_type=?, first_name=?, last_name=?, birthdate=?, reg_year=?, se_profile_id=?, se_registration_id=? WHERE id=?`)
    .run(x.eventType, x.firstName, x.lastName, x.birthdate, x.regYear, x.seProfileId, x.seRegistrationId, regId)
  const s = getSettings()
  let res: { outcome: Outcome; note: string; playerId?: string }
  if (x.regYear && x.regYear !== s.registrationYear) res = { outcome: 'wrong_year', note: `registration is for ${x.regYear}, board tracks ${s.registrationYear}` }
  else {
    const m = matchPlayer(x)
    if (m.player) res = { ...apply(regId, m.player, x, actor), playerId: m.player.id }
    else res = m
    if (!x.regYear) res.note += ' (season not found in payload)'
  }
  db.prepare('UPDATE registrations SET outcome = ?, note = ? WHERE id = ?').run(res.outcome, res.note, regId)
  changed()
  return res
}

export function storeRegistration(source: 'webhook' | 'csv' | 'manual', payload: unknown, verified: boolean): { id: number; duplicate: boolean } {
  const x = extract(payload)
  if (x.eventId) {
    const dup = db.prepare('SELECT id FROM registrations WHERE event_id = ?').get(`${source}:${x.eventId}`) as { id: number } | undefined
    if (dup) return { id: dup.id, duplicate: true }
  }
  const id = Number(db.prepare('INSERT INTO registrations (source, event_id, verified, raw) VALUES (?, ?, ?, ?)')
    .run(source, x.eventId ? `${source}:${x.eventId}` : null, verified ? 1 : 0, JSON.stringify(payload)).lastInsertRowid)
  return { id, duplicate: false }
}

/** Admin resolves an unmatched/ambiguous registration by pointing it at a player (or creating one). */
export function linkRegistration(regId: number, playerId: string | null, actor: string) {
  const r = db.prepare('SELECT * FROM registrations WHERE id = ?').get(regId) as { raw: string } | undefined
  if (!r) throw new Error('no such registration')
  const x = extract(JSON.parse(r.raw))
  let p: Player | undefined
  if (playerId) p = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId) as Player | undefined
  else {
    if (!x.firstName || !x.lastName) throw new Error('registration has no participant name')
    const s = getSettings()
    const name = `${x.firstName} ${x.lastName}`
    const id = uid()
    db.prepare(`INSERT INTO players (id, name, name_key, age, birthdate, kind, notes) VALUES (?, ?, ?, ?, ?, 'pool', '')`)
      .run(id, name, nameKey(name), x.birthdate ? leagueAge(x.birthdate, Number(s.season) || s.registrationYear, s.ageCutoff) : null, x.birthdate)
    audit(actor, 'player_added', id, { name, from: `registration ${regId}` })
    p = db.prepare('SELECT * FROM players WHERE id = ?').get(id) as Player
  }
  if (!p) throw new Error('unknown player')
  const res = apply(regId, p, x, actor)
  db.prepare('UPDATE registrations SET outcome = ?, note = ? WHERE id = ?').run(res.outcome, `${res.note} (linked by ${actor})`, regId)
  audit(actor, 'registration_linked', p.id, { registration: regId })
  changed()
  return res
}

export function ignoreRegistration(regId: number, actor: string) {
  db.prepare(`UPDATE registrations SET outcome = 'ignored', note = ? WHERE id = ?`).run(`ignored by ${actor}`, regId)
  changed()
}

/** SportsEngine registration report export (CSV). Each row runs through the same matcher as a webhook. */
export function importRegistrationCsv(text: string, actor: string) {

  const rows = parseCsv(text)
  if (rows.length < 2) throw new Error('Expected a header row and at least one registration')
  const header = rows[0]!.map((h) => h.trim())
  const tally: Record<string, number> = {}
  for (const row of rows.slice(1)) {
    const obj: Obj = { participant: Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])) }
    const { id } = storeRegistration('csv', obj, true)
    const res = processRegistration(id, actor)
    tally[res.outcome] = (tally[res.outcome] ?? 0) + 1
  }
  audit(actor, 'registrations_imported', null, tally)
  return tally
}
