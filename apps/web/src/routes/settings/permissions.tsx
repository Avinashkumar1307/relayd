import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Card, Icon, PageHeader, Tabs } from '@relayd/ui';
import { WORKSPACE_ROLES, can, type Permission, type WorkspaceRole } from '@relayd/types';
import { workspaceApi, workspaceKeys } from '../../api/workspace.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { ROLE_LABEL } from './workspace-parts.js';

/**
 * J2c — /settings/team/permissions.
 *
 * A reference table, and the one screen in the product where the
 * authorization model is stated in full. So it is *computed* from
 * `packages/types/src/permissions.ts` rather than transcribed: a matrix
 * drawn by hand goes stale the first time a permission moves, and a
 * permissions page that lies is worse than none.
 *
 * Each row below names the permissions a capability needs; a role gets a
 * tick when it holds all of them. The only special cell is "Request", which
 * is derived too: a role that can build a campaign but not launch it is
 * exactly the role that sees "Request launch" (CLAUDE.md section 11 —
 * `campaign:launch` is separate from `campaign:write`).
 *
 * Where this page and the J2c frame differ, the code wins and the
 * difference is real: the frame shows `billing:read` as Owner-only, and
 * `MATRIX` grants it to Admin as well, which is what the billing pages and
 * their guards already enforce.
 */

interface Capability {
  /** The sentence in the Capability column. */
  label: string;
  /** The 12px line under it. */
  note?: string;
  /** Every permission the capability needs. All of them, or no tick. */
  permissions: readonly Permission[];
  /**
   * A role holding this permission, but not the row's, gets the "Request"
   * chip instead of a dash.
   */
  requestWith?: Permission;
  /** The three billing/ownership rows the frame tints. */
  emphasis?: boolean;
}

const CAPABILITIES: readonly Capability[] = [
  {
    label: 'View dashboard, campaigns and reports',
    permissions: ['workspace:read', 'contact:read', 'provider:read'],
  },
  {
    label: 'Manage audience: contacts, lists, tags, segments, imports, suppressions',
    permissions: ['contact:write', 'contact:import'],
  },
  {
    label: 'Build campaigns and templates',
    note: 'Editors can save drafts and schedule test sends',
    permissions: ['campaign:write', 'template:write'],
  },
  {
    label: 'Launch, pause, resume, cancel campaigns',
    note: 'Editors see “Request launch”; an Owner or Admin approves',
    permissions: ['campaign:launch'],
    requestWith: 'campaign:write',
  },
  {
    label: 'Manage providers, senders and sending pools',
    note: 'Includes credentials and inbound webhook URLs',
    permissions: ['provider:write'],
  },
  {
    label: 'Manage team and roles',
    note: 'Admins cannot change or remove the Owner',
    permissions: ['member:invite', 'member:remove'],
  },
  {
    label: 'API keys and outbound webhooks',
    permissions: ['apikey:write'],
  },
  {
    label: 'billing:read — view plan, usage, invoices',
    permissions: ['billing:read'],
    emphasis: true,
  },
  {
    label: 'billing:write — change plan, payment method, cancel',
    note: 'Owner only, by design',
    permissions: ['billing:write'],
    emphasis: true,
  },
  {
    label: 'Transfer ownership, delete workspace',
    note: 'Typed confirmation required',
    permissions: ['workspace:delete'],
    emphasis: true,
  },
];

type Cell = 'allowed' | 'request' | 'denied';

export function cellFor(capability: Capability, role: WorkspaceRole): Cell {
  if (capability.permissions.every((permission) => can(role, permission))) return 'allowed';
  if (capability.requestWith !== undefined && can(role, capability.requestWith)) return 'request';
  return 'denied';
}

const CELL_LABEL: Readonly<Record<Cell, string>> = {
  allowed: 'Allowed',
  request: 'Can request',
  denied: 'Not allowed',
};

function Tick() {
  return (
    <span className="grid h-5.5 w-5.5 place-items-center rounded-full bg-success-soft text-success-text">
      <Icon name="check" size={13} strokeWidth={3} />
    </span>
  );
}

function Dash() {
  return <span className="grid h-5.5 w-5.5 place-items-center rounded-full bg-neutral-soft text-text-3" />;
}

function CellMark({ cell }: { cell: Cell }) {
  if (cell === 'request') {
    return (
      <span className="inline-flex h-5 items-center rounded-badge bg-info-soft px-1.75 text-label font-medium text-info-text">
        Request
      </span>
    );
  }
  return cell === 'allowed' ? <Tick /> : <Dash />;
}

export function TeamPermissionsPage() {
  const navigate = useNavigate();
  const { current } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';

  const members = useQuery({
    queryKey: workspaceKeys.members(workspaceId),
    queryFn: () => workspaceApi.members(),
  });
  const invitations = useQuery({
    queryKey: workspaceKeys.invitations(workspaceId),
    queryFn: () => workspaceApi.invitations(),
  });

  return (
    <>
      <PageHeader
        title="Team"
        description="What each role can do. Roles are fixed; there are no custom roles."
        tabs={
          <Tabs
            label="Team"
            variant="page"
            value="permissions"
            onChange={(key) => {
              if (key !== 'permissions') void navigate('/settings/team');
            }}
            items={[
              { key: 'members', label: 'Members', count: members.data?.length ?? 0 },
              { key: 'invitations', label: 'Invitations', count: invitations.data?.length ?? 0 },
              { key: 'permissions', label: 'Permissions' },
            ]}
          />
        }
      />

      <Card flush className="max-w-[1000px]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-ui">
            <caption className="sr-only">What each role can do</caption>
            <colgroup>
              <col />
              {WORKSPACE_ROLES.map((role) => (
                <col key={role} style={{ width: 120 }} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b border-border bg-tint text-caption font-medium text-text-2">
                <th scope="col" className="px-4.5 py-2.5 text-left font-medium">
                  Capability
                </th>
                {WORKSPACE_ROLES.map((role) => (
                  <th key={role} scope="col" className="px-3 py-2.5 text-center font-medium">
                    {ROLE_LABEL[role]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAPABILITIES.map((capability) => (
                <tr
                  key={capability.label}
                  className={`border-b border-border ${capability.emphasis === true ? 'bg-brand-soft' : ''}`}
                >
                  <th scope="row" className="px-4.5 py-2.5 text-left font-normal">
                    <span className="block font-medium">{capability.label}</span>
                    {capability.note === undefined ? null : (
                      <span className="block text-caption text-text-2">{capability.note}</span>
                    )}
                  </th>
                  {WORKSPACE_ROLES.map((role) => {
                    const cell = cellFor(capability, role);
                    return (
                      <td key={role} className="px-3 py-2.5">
                        <span className="flex justify-center">
                          <CellMark cell={cell} />
                          <span className="sr-only">{CELL_LABEL[cell]}</span>
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap gap-4 px-4.5 py-3 text-caption text-text-2">
          <span className="inline-flex items-center gap-1.5">
            <span className="grid h-4.5 w-4.5 place-items-center rounded-full bg-success-soft text-success-text">
              <Icon name="check" size={11} strokeWidth={3} />
            </span>
            Allowed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="grid h-4.5 w-4.5 place-items-center rounded-full bg-neutral-soft text-text-3">
              —
            </span>
            Not allowed
          </span>
          <span>
            Launching is separate from editing: Editors submit a launch request; an Owner or Admin approves
            it. Only the Owner holds{' '}
            <code className="rounded-4 bg-neutral-soft px-1.25 py-px font-mono text-label">billing:write</code>.
          </span>
        </div>
      </Card>
    </>
  );
}
