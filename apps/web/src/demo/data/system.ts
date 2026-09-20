import { iso } from './clock.js';

/**
 * Section K fixtures: the system states.
 *
 * DEMO ONLY. The K frames are not pages so much as conditions — a workspace
 * that is past due, one that is suspended, an account inside its first
 * seven days — and none of them is reachable by clicking. This file is how
 * each one is turned on, so a preview can actually be looked at.
 *
 * Every scenario is a patch over what `GET /workspaces/current` and
 * `GET /billing` already answer, keyed by the `?demo=` value in the URL.
 * The ids point at `design/sample-data.js`, so the banner's action lands on
 * the campaign and the connection the frames name.
 */

export type ScenarioKey =
  | 'past_due'
  | 'restricted'
  | 'suspended'
  | 'new_cap'
  | 'complaint_pause'
  | 'provider_failed';

export interface WorkspacePatch {
  status?: 'active' | 'past_due' | 'restricted' | 'suspended';
  alerts?: Record<string, unknown>;
  alertCount?: number;
}

export interface BillingPatch {
  workspaceSuspended?: boolean;
  pastDue?: boolean;
}

export interface Scenario {
  workspace: WorkspacePatch;
  billing: BillingPatch;
}

export const SCENARIOS: Readonly<Record<ScenarioKey, Scenario>> = {
  past_due: {
    workspace: { status: 'past_due' },
    billing: { pastDue: true },
  },
  restricted: {
    workspace: { status: 'restricted' },
    billing: { pastDue: true },
  },
  suspended: {
    workspace: { status: 'suspended' },
    billing: { pastDue: true, workspaceSuspended: true },
  },
  new_cap: {
    workspace: { alerts: { newAccountCap: { perDay: 500, endsAt: iso(-4) } } },
    billing: {},
  },
  complaint_pause: {
    workspace: {
      alerts: {
        complaintPause: { campaignId: 'cmp_6r9s2e', campaignName: 'Eid al-Etihad flash sale', rate: 0.0034 },
      },
    },
    billing: {},
  },
  provider_failed: {
    workspace: {
      alerts: { providerFailure: { connectionId: 'prv_sg_mkt', label: 'SendGrid · marketing' } },
    },
    billing: {},
  },
};

/**
 * What `GET /workspaces/current` gains in every scenario, including none.
 *
 * `alertCount` is the "Needs attention" rail's length, which is what puts
 * the red dot on the bell in every frame. It is deliberately not tied to
 * the banners: a workspace can have things worth looking at without any of
 * them being severe enough to take a strip across the top of every page.
 */
export const baseWorkspacePatch: WorkspacePatch = { status: 'active', alertCount: 3 };

export function scenarioFrom(search: string): ScenarioKey | null {
  const requested = new URLSearchParams(search).get('demo');
  return requested !== null && requested in SCENARIOS ? (requested as ScenarioKey) : null;
}
