# 2027 SE Major Draft Board

Live draft room for the Southeastern Majors draft, grown out of the original
"Majors Draft Room" Claude artifact. One Express app serves the board, the
admin tools and the SportsEngine webhook; state lives in SQLite.

- **`/`**: the read-only board (live over SSE): on-the-clock team and timer,
  rounds × teams grid with compensation rounds, picks owed and left, returning
  players with registration status dots, available pool, and rosters with CSV download.
- **`/admin`**: log in to make picks, plus the Players, Registrations, Setup and Activity tabs.

## Run

```sh
pnpm install
cp .env.example .env              # then fill in values
pnpm build
pnpm seed data/seed-artifact.json # teams, order and returning players from the artifact (first run only)
pnpm admin add <username>         # prompts for a password (10+ chars)
pnpm start                        # http://127.0.0.1:3030
```

Deployed as a **user** systemd unit (`se-draft-board.service`). After any
change: `pnpm build && systemctl --user restart se-draft-board`. Building
alone leaves the old code running.

Other commands: `pnpm admin list | passwd <u> | remove <u>`, `pnpm test`.

## How the draft works

Ported unchanged from the artifact (`src/lib/engine.ts`): each team owes
`rosterSize − returning players not marked "Not returning"` picks. Every round
uses the round-1 order (snake mode reverses even rounds; the coin-flip pair
swaps on even rounds), and a team only appears while it still owes picks.
That is how teams that lost more players get the later "comp" rounds.

The server is authoritative. It validates each pick, so two admins clicking at
once can't double-draft. If a roster change mid-draft makes a team owe fewer
picks than it has made, the extra pick is flagged on the board for an admin to remove.

## Admin overrides

- **Players tab**: edit any kid inline: name, age, returning vs pool, team,
  status, eval rank. **Lock** pins a status so SportsEngine can't change it.
  *History* shows every change and registration for that player.
- **Board**: click any made pick to swap the player or remove only that pick.
- **Setup**: season, registration year, roster size, order mode, coin-flip pair,
  round-1 order, team names and colours, bulk-paste the draft pool, undo, restart
  the clock, clear all picks (type CLEAR to confirm).
- **Activity**: an audit log of every change and who made it.

Eval notes, birthdates and SportsEngine ids are only ever sent to admins.
Set `VIEWER_PASSWORD` to put the public board behind a shared code.

## SportsEngine registrations

```
POST {BASE_URL}/webhooks/sportsengine/{SPORTSENGINE_WEBHOOK_TOKEN}
```

The admin Registrations tab shows the full URL. Without a token the endpoint
returns 503. Once SportsEngine issues a signing secret, set
`SPORTSENGINE_WEBHOOK_SECRET` (HMAC-SHA256 over the raw body, hex or base64,
optional `sha256=` prefix) and confirm `SPORTSENGINE_SIGNATURE_HEADER`.

**The payload mapping is provisional.** SportsEngine's schema wasn't available
when this was built, so `extract()` in `src/lib/sportsengine.ts` searches for the
usual spellings of participant first/last name, DOB, profile id and season, and
prefers fields under participant-like keys over guardian/billing ones. Every
delivery is **stored raw before processing**. When real payloads arrive:
check a few with *Raw* in the inbox, tighten `extract()`, rebuild, then use
*Re-run matching on open items*.

For each registration, the flow is:

1. If the season year is found and isn't the board's **registration year**, it's
   filed under "Other years" and nothing changes.
2. Match on the SportsEngine profile id, then on the normalised name (accents,
   punctuation and Jr/II stripped), filtered by birthdate when both sides have one.
3. If it matches, the status becomes **Registered** and the SE ids are saved on the
   player. A cancel/withdraw/refund event type sets it back to Not registered.
   Locked players are skipped, and so are players marked "Not returning", because
   changing those alters a team's pick count.
4. If nothing matches, or more than one player does, it waits in the inbox for an
   admin to link it to a player, create a new pool player from it, or ignore it.

Duplicate deliveries with the same event `id` are stored once. Until the
webhook is live, export the registration report from SportsEngine HQ as CSV and
import it on the Registrations tab. It goes through the same matcher.

## Shared league login

Admin accounts live in one place for every league tool:
`/home/greg/apps/league-data/auth.db` (`AUTH_DB_PATH`). With
`COOKIE_DOMAIN=.crushworldseries.com`, signing in on any tool signs you in on
all of them, and signing out of one signs you out of all of them. `pnpm admin
add|passwd|remove|list` in either app manages the same accounts.
