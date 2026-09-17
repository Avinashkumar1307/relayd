import type { Brand } from './brand.js';

/**
 * Branded entity ids.
 *
 * UUIDv7, generated in the application (CLAUDE.md section 8) — except the
 * append-only high-volume event tables, which use BIGSERIAL for index
 * locality and are not branded here.
 *
 * Each phase adds the ids for the tables it introduces. These are the ids
 * named in CLAUDE.md section 3 plus UserId, which Phase 1 needs.
 */
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type UserId = Brand<string, 'UserId'>;
export type CampaignId = Brand<string, 'CampaignId'>;
export type RecipientId = Brand<string, 'RecipientId'>;
