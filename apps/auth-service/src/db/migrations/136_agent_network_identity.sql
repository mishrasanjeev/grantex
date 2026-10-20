-- SPDX-License-Identifier: Apache-2.0
-- Agent network identity (G50).
--
-- agents.http_signature_directory: the agent's developer has opted in to
-- publishing the agent's usable P-256 and Ed25519 keys in the registry's
-- HTTP Message Signatures key directory,
-- GET /.well-known/http-message-signatures-directory
-- (draft-meunier-webbotauth-httpsig-directory-00), which is served only when
-- HTTP_SIGNATURE_DIRECTORY_ENABLED=true. Default false: no key is published
-- unless its developer asks for it with
-- PUT /v1/agents/:id/http-signature-directory.
--
-- Additive and idempotent: a constant default (no table rewrite), and a
-- partial index the directory query reads.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS http_signature_directory BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_agents_http_signature_directory
  ON agents (id) WHERE http_signature_directory;
