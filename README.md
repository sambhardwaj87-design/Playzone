# PLAYZONE

A mobile-first social gaming MVP with Main Admin, Master and Player roles.

The application source is in **[playzone-app](./playzone-app/)**.

## Run in GitHub Codespaces

```bash
cd playzone-app
cp .env.example .env
npm install
npm start
```

Before starting, edit `.env` and replace both placeholder values:
- `INITIAL_SETUP_KEY`: a unique one-time key for creating the first Main Admin.
- `SESSION_SECRET`: at least 32 random characters.

Then open forwarded port **3000** and complete the first-time Main Admin setup screen.

## Points model

- Main Admin creates Masters and assigns quotas from a central reserve.
- Masters create and manage only their own Players.
- Player credits use the assigned Master's available quota; debits return points to that quota.
- Players cannot issue, transfer, purchase or redeem points.
- Ledger entries record point and quota changes.
- The number challenge is entertainment-only and never changes balances.

## Security and production readiness

The MVP includes password hashing, hashed session tokens, HTTP-only same-site cookies, role checks, security response headers, no-store API responses, basic login/setup throttling, and SQLite foreign-key enforcement.

It is **not yet production-certified**. Before public launch, add automated authorization/integration tests, persistent database storage and tested backups, monitoring, MFA for administrators, account recovery, a shared rate-limit store for multi-instance deployments, and an independent security review. Never commit `.env` or real credentials.

Virtual points have no cash value and are not redeemable.
