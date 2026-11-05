AI-Powered Transportation Operating System

An intelligent operating system for building and scaling a modern trucking company—from first CDL job to owner-operator to multi-truck fleet.

The platform will centralize business, fleet, financial, freight, fuel, maintenance, compliance, and driver data while using AI to analyze operations and recommend profitable decisions.

Core capabilities will include:

- 🚛 Fleet and asset management
- 📊 Revenue, expense, profit, and cash-flow tracking
- 🛣️ Load profitability and route analysis
- ⛽ Fuel-price optimization and fuel routing
- 📍 Truck positioning and Florida freight-trap mitigation
- 🏠 Home-time and schedule optimization
- 🔧 Predictive maintenance and repair tracking
- 📋 DOT/FMCSA compliance management
- 🤖 AI-powered business intelligence and decision support
- 📧 Automated freight research, outreach, and workflow preparation
- 📈 Fleet expansion and owner-operator readiness analysis

The long-term vision is to create a transportation company where trucks generate the cash flow, software coordinates the operation, and AI continuously improves the business.

Build the machine. The money follows.

---

## Working in this repository

- **Status and what's next:** `PROJECT_STATE.md` (where the project stands), `docs/work-queue.md` (everything pending, in order), `ROADMAP.md`.
- **Process:** this project is spec-first — see `CLAUDE.md` and the workflow document before changing anything. Designs live in `docs/design/`, contracts in `docs/api-contracts.md` and `docs/schemas.md`.
- **Run it:** `npm install`, copy `.env.example` to `.env.local` and fill in the values (placeholders only are committed; the repository is public — never commit real keys or personal data), then `npm run dev`.
- **The gate before any push:** `npx tsc --noEmit`, `npx eslint .`, `npx vitest run`, `npx next build`. Database changes also run the SQL checks in `tests/db/` (see its README) on a clean scratch Postgres.
- **Honest limits:** this is a paper-log *helper*, not a certified ELD; the AI recommends and never acts without an approval; time is shown in the viewer's zone, never UTC.
