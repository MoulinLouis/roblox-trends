import { defineConfig } from "drizzle-kit";

// No dbCredentials: `generate` only reads the schema and the snapshots in drizzle/. Migrations are applied by
// `npm run db:migrate`, which refuses a v1 database; `drizzle-kit push` or `studio` would skip that guard.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  strict: true,
  verbose: true,
});
