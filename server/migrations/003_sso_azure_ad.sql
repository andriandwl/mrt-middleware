-- 003_sso_azure_ad.sql — Fase 4: SSO Azure AD (Microsoft Entra ID)
--
-- 1. sso_role_mappings: memetakan klaim token Azure AD (App Role atau ID grup) → role + scope middleware.
--    Role efektif pengguna = role tertinggi dari semua mapping yang cocok; scope = gabungan.
-- 2. api_clients.expires_at: API key (untuk aplikasi/service) punya masa berlaku.
-- 3. audit_logs.auth_type: 'api_key' | 'sso' — membedakan akses aplikasi dan akses orang.

CREATE TABLE IF NOT EXISTS sso_role_mappings (
  id           bigserial PRIMARY KEY,
  claim_type   text        NOT NULL CHECK (claim_type IN ('role', 'group')),
  claim_value  text        NOT NULL,          -- nilai App Role (mis. MW.OCC.Operator) atau object ID grup
  role         text        NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  scopes       text[]      NOT NULL DEFAULT '{}',
  description  text,
  active       boolean     NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (claim_type, claim_value)
);

-- Mapping awal yang disarankan (App Role di app registration API). Ubah sesuai struktur organisasi.
INSERT INTO sso_role_mappings (claim_type, claim_value, role, scopes, description) VALUES
  ('role', 'MW.Admin',        'admin',    '{*:*}',                     'Administrator middleware'),
  ('role', 'MW.OCC.Operator', 'operator', '{scada:*,nms:*,pids:*}',    'Operator OCC — semua sumber & stasiun'),
  ('role', 'MW.Viewer',       'viewer',   '{*:*}',                     'Pemantau — baca semua data')
ON CONFLICT (claim_type, claim_value) DO NOTHING;

ALTER TABLE api_clients ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS auth_type text;
