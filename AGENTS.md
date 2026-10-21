# Repository guidance

- Write all source code, identifiers, comments, tests, documentation, configuration, logs, and UI copy in English.
- Communicate with the repository owner in French.
- Keep the product as one Next.js application backed by one PostgreSQL 18 database with TimescaleDB.
- Put reusable domain logic in `src/lib`, persistence in `src/db`, pages in `src/app`, scheduled and operations entry points in `scripts`, and server units, configuration and shell scripts in `ops`.
- Production runs on one server described in `docs/operations.md`; change it only through the repository and the runbook, never by hand-editing files that `ops/` manages.
- Keep collection intervals, thresholds and limits centralized in `src/lib/config.ts`; avoid hidden constants in jobs or UI code.
- Preserve collection idempotency (observations are keyed by slot) and isolate external-source failures.
- Use `npm run db:migrate` and `npm run collect` for local setup with live data; `npm run status` reports collection health.
- Never insert synthetic or demo games into the application database. Test fixtures belong only in disposable test databases.
- `LEGACY_DATABASE_URL` points to the production v1 database. Only `npm run import:legacy` reads it, in read-only transactions, and only during the documented production runbook steps (the first production deployment in phase 1b, the final incremental import in phase 4), always with `DATABASE_URL` set to the v2 database. Never point `DATABASE_URL` at the v1 database.
- Before handing off changes, run `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
