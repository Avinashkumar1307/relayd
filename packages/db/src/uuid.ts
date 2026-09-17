import { v7 as uuidV7 } from 'uuid';

/**
 * UUIDv7 primary key, generated in the application (CLAUDE.md section 8).
 *
 * v7 is time-ordered, so inserts land at the right-hand edge of the index
 * instead of scattering across it the way v4 does. That matters here because
 * campaign_recipients takes bulk inserts in the hundreds of thousands.
 *
 * The exceptions are the append-only high-volume event tables (email_events,
 * automation_events), which use BIGSERIAL for even tighter index locality.
 */
export function uuidv7(): string {
  return uuidV7();
}
