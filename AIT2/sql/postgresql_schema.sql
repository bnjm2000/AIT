CREATE TABLE IF NOT EXISTS aim_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS aim_companies (
    company_code TEXT PRIMARY KEY,
    company_name TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS aim_company_revisions (
    company_code TEXT PRIMARY KEY REFERENCES aim_companies(company_code) ON DELETE CASCADE,
    revision BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS aim_global_state (
    state_key TEXT PRIMARY KEY,
    revision BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO aim_global_state (state_key, revision)
VALUES ('users', 0)
ON CONFLICT (state_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS aim_users (
    company_code TEXT NOT NULL REFERENCES aim_companies(company_code) ON DELETE CASCADE,
    username TEXT NOT NULL,
    data JSONB NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (company_code, username),
    CONSTRAINT aim_users_data_object CHECK (jsonb_typeof(data) = 'object')
);

-- Upgrade databases created by schema version 1. Existing unscoped users are
-- retained under one company; the data migration subsequently replaces each
-- company's users with its assigned accounts.
ALTER TABLE aim_users ADD COLUMN IF NOT EXISTS company_code TEXT;
DO $$
DECLARE
    fallback_company TEXT;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'aim_users'
          AND column_name = 'company_code'
          AND is_nullable = 'YES'
    ) THEN
        SELECT company_code INTO fallback_company
        FROM aim_companies ORDER BY company_code LIMIT 1;
        IF fallback_company IS NOT NULL THEN
            UPDATE aim_users SET company_code = fallback_company
            WHERE company_code IS NULL;
            ALTER TABLE aim_users ALTER COLUMN company_code SET NOT NULL;
        END IF;
    END IF;
END $$;
DO $$
DECLARE
    constraint_columns TEXT[];
BEGIN
    SELECT array_agg(att.attname ORDER BY ord.ordinality)
    INTO constraint_columns
    FROM pg_constraint con
    JOIN unnest(con.conkey) WITH ORDINALITY ord(attnum, ordinality) ON TRUE
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ord.attnum
    WHERE con.conrelid = 'aim_users'::regclass AND con.contype = 'p';
    IF constraint_columns = ARRAY['username']::TEXT[] THEN
        ALTER TABLE aim_users DROP CONSTRAINT aim_users_pkey;
        ALTER TABLE aim_users ADD PRIMARY KEY (company_code, username);
    END IF;
END $$;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'aim_users'::regclass
          AND conname = 'aim_users_company_code_fkey'
    ) THEN
        ALTER TABLE aim_users
        ADD CONSTRAINT aim_users_company_code_fkey
        FOREIGN KEY (company_code) REFERENCES aim_companies(company_code)
        ON DELETE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS aim_users_company_idx
    ON aim_users (company_code);

CREATE TABLE IF NOT EXISTS aim_inventory (
    company_code TEXT NOT NULL REFERENCES aim_companies(company_code) ON DELETE CASCADE,
    asset_id TEXT NOT NULL,
    data JSONB NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (company_code, asset_id),
    CONSTRAINT aim_inventory_data_object CHECK (jsonb_typeof(data) = 'object')
);

CREATE INDEX IF NOT EXISTS aim_inventory_company_idx
    ON aim_inventory (company_code);
CREATE INDEX IF NOT EXISTS aim_inventory_data_gin_idx
    ON aim_inventory USING GIN (data);

CREATE TABLE IF NOT EXISTS aim_containers (
    company_code TEXT NOT NULL REFERENCES aim_companies(company_code) ON DELETE CASCADE,
    container_id TEXT NOT NULL,
    data JSONB NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (company_code, container_id),
    CONSTRAINT aim_containers_data_object CHECK (jsonb_typeof(data) = 'object')
);

CREATE TABLE IF NOT EXISTS aim_events (
    company_code TEXT NOT NULL REFERENCES aim_companies(company_code) ON DELETE CASCADE,
    event_id BIGINT NOT NULL,
    event_name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    state TEXT NOT NULL,
    source_filename TEXT NOT NULL DEFAULT '',
    data JSONB NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (company_code, event_id),
    CONSTRAINT aim_events_data_object CHECK (jsonb_typeof(data) = 'object')
);

CREATE INDEX IF NOT EXISTS aim_events_company_dates_idx
    ON aim_events (company_code, start_date, end_date);
CREATE INDEX IF NOT EXISTS aim_events_company_state_idx
    ON aim_events (company_code, state);

CREATE TABLE IF NOT EXISTS aim_event_history (
    history_id BIGSERIAL PRIMARY KEY,
    company_code TEXT NOT NULL,
    event_id BIGINT NOT NULL,
    event_name TEXT NOT NULL,
    source_filename TEXT NOT NULL DEFAULT '',
    data JSONB NOT NULL,
    source_version BIGINT NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS aim_event_history_lookup_idx
    ON aim_event_history (company_code, event_id, archived_at DESC);

CREATE TABLE IF NOT EXISTS aim_system_logs (
    log_id BIGSERIAL PRIMARY KEY,
    company_code TEXT NOT NULL REFERENCES aim_companies(company_code) ON DELETE CASCADE,
    timestamp_text TEXT NOT NULL,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS aim_system_logs_company_idx
    ON aim_system_logs (company_code, log_id DESC);

CREATE TABLE IF NOT EXISTS aim_clients (
    company_code TEXT NOT NULL REFERENCES aim_companies(company_code) ON DELETE CASCADE,
    client_name TEXT NOT NULL,
    data JSONB NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (company_code, client_name),
    CONSTRAINT aim_clients_data_object CHECK (jsonb_typeof(data) = 'object')
);

CREATE TABLE IF NOT EXISTS aim_departments (
    company_code TEXT NOT NULL REFERENCES aim_companies(company_code) ON DELETE CASCADE,
    department_code TEXT NOT NULL,
    data JSONB NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (company_code, department_code),
    CONSTRAINT aim_departments_data_object CHECK (jsonb_typeof(data) = 'object')
);

CREATE TABLE IF NOT EXISTS aim_company_documents (
    company_code TEXT NOT NULL REFERENCES aim_companies(company_code) ON DELETE CASCADE,
    document_key TEXT NOT NULL,
    data JSONB NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (company_code, document_key),
    CONSTRAINT aim_company_documents_data_object CHECK (jsonb_typeof(data) = 'object')
);

CREATE TABLE IF NOT EXISTS aim_migration_runs (
    migration_id BIGSERIAL PRIMARY KEY,
    company_code TEXT NOT NULL,
    source_folder TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    imported_counts JSONB NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO aim_schema_migrations (version)
VALUES (1)
ON CONFLICT (version) DO NOTHING;

INSERT INTO aim_schema_migrations (version)
VALUES (2)
ON CONFLICT (version) DO NOTHING;
