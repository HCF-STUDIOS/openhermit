-- Single-use token redemption ledger.
--
-- Backs `POST /api/auth/exchange`: when an exchange-purpose JWT is redeemed
-- for a session JWT, the gateway records its `jti` here so a replay attempt
-- (e.g. someone who scraped the connect URL out of a browser's history before
-- the SPA could clear it) is rejected with 401.
--
-- Rows are insert-once. `expires_at` mirrors the JWT's `exp` claim (unix
-- seconds) so a periodic sweep can drop rows once the underlying token has
-- expired anyway — replay protection past expiry is moot because verifyJwt
-- would already reject the token.

CREATE TABLE "consumed_jtis" (
  "jti" text PRIMARY KEY,
  "expires_at" integer NOT NULL,
  "consumed_at" text NOT NULL
);

CREATE INDEX "consumed_jtis_expires_at_idx" ON "consumed_jtis" ("expires_at");
