-- Additive migration. Apply to the isolated test database first, never automatically at startup.
BEGIN;
CREATE TABLE IF NOT EXISTS collection_invitations (
 id bigserial PRIMARY KEY,
 code varchar(20) NOT NULL UNIQUE,
 owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 album_id integer NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS collection_invitations_active ON collection_invitations(owner_id,album_id) WHERE active;
CREATE TABLE IF NOT EXISTS collection_invitation_visitors (
 user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 invitation_id bigint NOT NULL REFERENCES collection_invitations(id) ON DELETE CASCADE,
 new_signup boolean NOT NULL DEFAULT false,
 qualified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
