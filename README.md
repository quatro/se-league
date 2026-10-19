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
  - **Blind** (T-Ball): returners stay on their teams, as above. Each kid in the pool gets a hidden random number. A
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

- **Back on the same team** in a keep-teams division (Majors, Minors, Rookie, T-Ball)
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

Registration campaigns (Signups tab): see "Registration" below.

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

## Registration

The **Signups** tab builds a registration campaign for each session: "2027
Spring", a summer team, a fall league. Each campaign has:

- **A public form** at `/register/<slug>`. Draft campaigns are visible only to
  admins, through the Preview button.
- **Programs.** Usually the season's divisions. Majors + Minors is one
  "Major/Minor" program that counts both leagues' seats. A standalone program
  has its own ages and cap. Families only see programs their player's league
  age fits. A full program offers a **free waitlist**.
- **Fees and add-ons, charged per player.** Each is either required or
  optional, with a quantity picker when Max is above 1, and can be limited to
  certain programs. A tag (e.g. `volunteer-exempt`) follows the purchase onto
  the kid's record.
- **Returning players.** Once a player's name and birthdate are in, the form
  looks for them on last season's rosters (same name, or same birthdate and
  last name; for older records without a birthdate, the age has to fit). The
  family confirms "Yes, that's them" or "No, new player", so the registration
  lands on the kid's existing record and their birthdate is saved for next year.
- **Questions,** either per player or once per family. Types are short answer,
  paragraph, number, date, yes/no, pick one, pick any, and an agreement the
  family must tick (the waiver).

Payment uses Stripe Checkout. The moment Stripe confirms, each kid is
Registered in their division:

- Expected returners flip to Registered.
- New 10–12 kids join the Majors tryout pool.
- Seat counts and drafts update.

The thank-you page also asks Stripe directly, so a missing webhook never leaves
a paid family unregistered.

- **Abandoned checkouts** are cancelled when Stripe expires them.
- **Refunds** made in Stripe are flagged on the order, and an admin decides
  whether to withdraw the kid.
- **Waitlisted kids** cost nothing until an admin clicks **Offer the spot**,
  which makes a payment link to send to the family.

**SportsEngine:** export one row per player with the parent's details, every
purchase and every answer. After entering them, tick **In SE**, or use **Mark
shown as in SportsEngine**, so the next "not yet in SportsEngine" export only
has new families.

To set up Stripe:

1. Put `STRIPE_SECRET_KEY` in `.env` (`sk_test_…` first).
2. Run `pnpm tsx scripts/stripe-webhook.ts`.
3. Run `systemctl --user restart se-league`.

To go live, swap in the `sk_live_…` key and repeat steps 2 and 3. Test-mode
orders are labelled "test".

## Outreach: asking returning families to register early

**Outreach** emails the parents of returning players (Expected / Need to
contact) in chosen divisions. Each parent email gets one message covering all
of their kids, with a personal link (`/register/<slug>?invite=…`) that fills in
the form; the form still asks them to confirm each returning player. Kids
already Registered are never emailed, so sending again later is a reminder to
whoever hasn't signed up. The Sent list shows who clicked and how many kids
have registered since.

Parent contacts live on each kid's record (click a name). Paste a contact list
or the SportsEngine parent export on the Outreach tab; every paid registration
adds the parent too. Email goes out through Resend (`RESEND_API_KEY`,
`MAIL_FROM` with a verified domain). Without it, **Export list with personal
links** gives a CSV for sending from another tool.
