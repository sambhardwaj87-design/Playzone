# PLAYZONE

A mobile-first social gaming MVP with Main Admin, Master and Player roles.

## Run in GitHub Codespaces

1. Open the repository in Codespaces.
2. In the terminal run `cp .env.example .env`.
3. Edit `.env` and set a unique `INITIAL_SETUP_KEY` and `SESSION_SECRET` (at least 32 random characters).
4. Run `npm install`.
5. Run `npm start`.
6. Open forwarded port 3000.
7. Create the Main Admin through the first-time setup screen.

## Roles and virtual points

- Main Admin creates Masters and assigns fixed quotas from a central reserve.
- Masters create and manage only their own Players.
- Masters credit players from their available quota; debits return points to that master's available quota.
- Players cannot create, issue, transfer, buy or redeem points.
- Ledger entries are recorded for quota and player balance changes.
- The sample number game is for fun only and does not award or deduct points.

## Important

This is an MVP starter, not a production-certified service. Before public launch, add automated authorization tests, rate limiting, MFA for admins, backups, monitoring, account recovery, CSRF protections appropriate to the deployment, and a professional security review. Use persistent disk storage for the SQLite database. Never commit `.env` or real credentials. Virtual points have no cash value and are not redeemable.
