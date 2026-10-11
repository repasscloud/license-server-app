-- Least-privilege database roles. Run ONCE per database as the owner/migration role, AFTER
-- migrations, with psql variables (never commit real passwords):
--
--   psql "$DATABASE_URL_OWNER" -v runtime_password="$(security find-generic-password -s repass-db-runtime -w)" -f sql/roles.sql
--
-- repass_runtime is the ONLY role Hyperdrive/the Worker uses. It cannot run DDL, cannot update
-- or delete append-only history, and cannot delete signing keys or their encrypted secrets.
-- Re-run the GRANT section after future migrations that add tables.

\set ON_ERROR_STOP on
SELECT format('CREATE ROLE repass_runtime LOGIN PASSWORD %L', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repass_runtime') \gexec
SELECT format('ALTER ROLE repass_runtime PASSWORD %L', :'runtime_password') \gexec
ALTER ROLE repass_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE repass_runtime SET statement_timeout = '15s';
ALTER ROLE repass_runtime SET idle_in_transaction_session_timeout = '30s';

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM repass_runtime;
GRANT USAGE ON SCHEMA public TO repass_runtime;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO repass_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO repass_runtime;

-- Append-only history: insert/select only.
REVOKE UPDATE ON audit_events, license_issuances, transfer_events, revocations, key_lifecycle_events,
  entitlement_policy_snapshots, purchase_lines FROM repass_runtime;

-- Housekeeping tables the application legitimately deletes from.
GRANT DELETE ON rate_limit_buckets, auth_challenges, auth_sessions, idempotency_records, outbox_jobs,
  email_outbox, customer_members, admin_user_roles TO repass_runtime;

-- Migration bookkeeping is read-only for the runtime.
REVOKE ALL ON schema_migrations FROM repass_runtime;
GRANT SELECT ON schema_migrations TO repass_runtime;
