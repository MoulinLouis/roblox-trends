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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
