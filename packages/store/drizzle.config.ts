import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // drizzle-kit (generate/push/studio) issues DDL and introspection that a
    // transaction-mode pooler can't serve reliably; prefer a direct/session
    // connection when one is configured, falling back to DATABASE_URL.
    url: (process.env.DIRECT_URL ?? process.env.DATABASE_URL)!,
  },
});
