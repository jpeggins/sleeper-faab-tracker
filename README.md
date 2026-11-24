# Sleeper FAAB Tracker

Static single-page app that tracks FAAB for a Sleeper league with weekly scoring bonuses:

- Weekly **high** scorer: +$3 FAAB
- Weekly **low** scorer: +$7 FAAB (ties: every tied team gets it)

Sleeper caps FAAB at the league budget ($100), so bonuses above the cap can't be entered in Sleeper. This page keeps the real ledger:

- **Real balance** = budget − winning waiver bids ± FAAB traded + bonuses (no cap)
- **Should show** = real balance capped at the budget — what Sleeper should display
- **In Sleeper** = budget − `waiver_budget_used` from the Sleeper API
- **Banked** = real balance above the cap, added in Sleeper once the team spends below it

Rows where Sleeper doesn't match "Should show" are red, with the amount to add or remove. Click a team to see each spend and bonus with a running balance.

Only completed regular-season weeks earn bonuses. The bonus amounts can be changed at the top of the page (defaults in `js/config.js`) and are kept in the URL as `?top=<n>&low=<n>`; `?league=<id>` loads another league.

## Run locally

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

Deploys as-is on GitHub Pages (branch root).
