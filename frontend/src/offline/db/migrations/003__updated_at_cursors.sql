-- Migration 003: Add last_updated_at to sync_cursors
-- Converts the synchronization logic to be mutation-driven instead of creation-driven.
-- We initialize last_updated_at to the existing last_created_at value to ensure
-- a smooth transition for existing offline databases.

ALTER TABLE sync_cursors ADD COLUMN last_updated_at TEXT;

UPDATE sync_cursors SET last_updated_at = last_created_at;
