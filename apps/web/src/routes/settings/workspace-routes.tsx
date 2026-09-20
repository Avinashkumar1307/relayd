import { Route } from 'react-router';
import { RequirePermission } from '../../auth/guards.js';
import { WorkspaceSettingsPage } from './workspace.js';
import { TeamSettingsPage } from './team.js';
import { TeamPermissionsPage } from './permissions.js';
import { ProfilePage } from './profile.js';
import { AuditLogPage } from './audit.js';

/**
 * Section J, part one: the workspace, the people in it, your own account and
 * the record of what everyone did.
 *
 * Kept apart from the platform fragment next door because these pages are
 * about people and that one is about machines, and they are built by
 * different teams.
 *
 * Only the audit log is guarded at the route: `audit:read` is Owner and
 * Admin, and an Editor who follows a link to it gets K3's locked page rather
 * than an empty table. The other three pages are readable by every member —
 * what a role cannot *do* on them is disabled control by control, with the
 * reason in the tooltip (docs/09).
 *
 * /settings/team/permissions is a page rather than a tab panel because it is
 * a reference table people link each other to.
 */
export const settingsWorkspaceRoutes = (
  <>
    <Route path="/settings/workspace" element={<WorkspaceSettingsPage />} />
    <Route path="/settings/team" element={<TeamSettingsPage />} />
    <Route path="/settings/team/permissions" element={<TeamPermissionsPage />} />
    <Route path="/settings/profile" element={<ProfilePage />} />
    <Route
      path="/settings/audit"
      element={
        <RequirePermission permission="audit:read">
          <AuditLogPage />
        </RequirePermission>
      }
    />
  </>
);
