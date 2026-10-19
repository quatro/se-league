# SE Baseball League

One app for running the league year after year: every kid's history,
registration seat counts, and a draft room for each division. Finishing a
season builds the next one from it.

- **Seasons.** 2026 is finished; 2027 is being organized. Use the season
  picker in the header to look at any year.
- **Kids.** Each kid is one permanent record (name, birthdate, SportsEngine
  id). Each season they get an enrollment: division, team, status, and how they
  got there. Click a kid's name for their history across seasons.
- **Seats** (public). Open seats per division (teams × roster, minus
  registrations and seats held for expected returners), with a headline saying
  which divisions to close. Majors + Minors are one card, because families
  register for them once and the drafts decide.
- **Drafts.** One room per division per season, at `/draft/<year>/<division>`:
  - **Standard** (Majors, Minors, Rookie): returners stay on their teams. Each
    team owes roster size minus its returners, so teams that lost more players
    get the later comp rounds. The order is straight or snake, and can be set
    from last season's records (worst record picks first).
  - **Blind** (T-Ball): each kid in the pool gets a hidden random number. A
    coach picks a number and that reveals the kid. Late registrations get the
    next numbers, so nobody else's number changes.
  - **Handoff:** closing the Majors draft moves everyone not picked into the
    Minors draft. The Minors draft can't pick until Majors is closed.

## The 10–12 rules

Families register for "Major/Minor" once, and that registration lands in the
shared pool.

| Kid | What happens |
|---|---|
| Majors last year | Stays on the same Majors team |
| Minors last year, not trying out | Stays on the same Minors team |
| Minors last year, trying out | Gives up the Minors team and goes into the Majors draft. If not picked, goes into the Minors draft, not back to the old team. |
| New 10–12, or a 9 turning 10 | Tries out by default: Majors draft, then Minors draft |
| 9-year-old marked "trying out" | Majors draft, then Minors draft. If not picked, stays in the 9-Year-Old League. |

## Rollover: finishing a season

**Seasons → Finish 2027 and start 2028** copies the season's setup: divisions,
teams in the same draft order, and the draft rooms. Then every kid who played
gets an *Expected* spot in the new season:

- **Back on the same team** in a keep-teams division (Majors, Minors, Rookie)
  while still young enough.
- **Otherwise** into the division their new league age fits, entering its
  draft.
- **Too old for every division:** graduated, not carried forward.

Rosters for a finished season can be pasted later (Divisions & Teams → Paste
rosters). Those kids are carried into the next season the same way.

## Run

```sh
pnpm install
cp .env.example .env            # then fill in values
pnpm build
pnpm start                      # http://127.0.0.1:3040
pnpm test
pnpm admin add|passwd|remove|list <username>   # shared league accounts
```

It is deployed as the **user** systemd unit `se-league` on port 3040, serving
https://registration.crushworldseries.com. After any change, run
`pnpm build && systemctl --user restart se-league`.

Draft-room hostnames come from `DRAFT_HOSTS` (e.g.
`2027majordraft.crushworldseries.com=2027/majors`). Point that site's nginx at
port 3040 with `sudo bash cutover-draft-domain.sh`.

`scripts/migrate.ts` was the one-time import from the first two apps
(se-draft-board, se-registration).

## SportsEngine

```
POST {BASE_URL}/webhooks/sportsengine/{SPORTSENGINE_WEBHOOK_TOKEN}
```

A registration finds its season by the year in the payload (else the current
season). It finds the kid by SportsEngine id, then by name plus birthdate, and
places them by the program the family picked, matched against each division's
**SE words**.

- An admin's move to another division is pinned: a re-run registration won't
  undo it.
- A cancellation releases the seat.
- Anything that can't be placed lands in the Registrations inbox.

The payload mapping in `src/lib/sepayload.ts` is a tolerant guess until real
deliveries arrive. Every delivery is stored raw, so you can tighten the
mapping, rebuild, and use **Re-run placement on open items**.
