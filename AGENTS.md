# Repository guidance

- Write all source code, identifiers, comments, tests, documentation, configuration, logs, and UI copy in English.
- Communicate with the repository owner in French.
- Keep the product as one Next.js application backed by one PostgreSQL-compatible database.
- Put reusable domain logic in `src/lib`, persistence in `src/db`, pages in `src/app`, and scheduled entry points in `scripts`.
- Keep scoring thresholds and weights centralized in `src/lib/config.ts`; avoid hidden scoring constants in UI code.
- Preserve collection idempotency and isolate external-source failures.
- Use `npm run db:migrate`, `npm run collect`, and `npm run analyze` for local setup with live data.
- Never insert synthetic or demo games into the application database.
- Before handing off changes, run `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build`.
