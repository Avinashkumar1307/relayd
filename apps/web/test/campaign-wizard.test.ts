import { describe, expect, it } from 'vitest';
import { STATUS_LABELS, pollIntervalFor, type CampaignStatus } from '../src/api/campaigns.js';
import {
  WIZARD_STEPS,
  canLaunch,
  isEditable,
  launchBlockedReason,
  preflight,
  preflightSummary,
  stepIndexFor,
  stepsWithIssues,
  type PreflightCheck,
  type PreflightInput,
} from '../src/routes/campaigns/wizard-steps.js';

/**
 * The wizard's rules, tested without rendering anything.
 *
 * The pre-flight is deliberately not the authority — `launchCampaign` on the
 * server re-checks every one of these inside the transaction, because the
 * audience can change between the review step and the click. What it buys is
 * telling the author on the step that can fix it, so what matters is that it
 * names the right step and distinguishes "you cannot send this" from "you
 * probably want to know".
 */

function input(over: Partial<PreflightInput> = {}): PreflightInput {
  return {
    campaign: {
      name: 'Spring',
      subjectOverride: 'Our spring sale is here',
      templateVersionId: 'v1',
      senderAccountId: 'sa-1',
      sendingPoolId: null,
      audience: { listIds: ['l1'] },
    },
    audienceCount: { eligible: 1000, suppressed: 0 },
    senderVerified: true,
    unsatisfiableMergeTags: [],
    ...over,
  };
}

describe('a campaign that is ready', () => {
  it('has no issues at all', () => {
    expect(preflight(input())).toEqual([]);
  });

  it('can be launched', () => {
    expect(canLaunch(preflight(input()))).toBe(true);
  });
});

describe('canLaunch', () => {
  it('refuses when anything is blocking', () => {
    // The happy-path assertion alone passes just as well against a function
    // that always returns true.
    const issues = preflight(input({ campaign: { ...input().campaign, templateVersionId: null } }));

    expect(issues.some((i) => i.severity === 'blocking')).toBe(true);
    expect(canLaunch(issues)).toBe(false);
  });

  it('refuses when one of several issues is blocking', () => {
    const issues = preflight(
      input({
        campaign: { ...input().campaign, name: '' },
        audienceCount: { eligible: 900, suppressed: 100 },
      }),
    );

    expect(canLaunch(issues)).toBe(false);
  });
});

describe('what blocks a launch', () => {
  it('a missing name', () => {
    const issues = preflight(input({ campaign: { ...input().campaign, name: '   ' } }));
    expect(issues).toContainEqual(
      expect.objectContaining({ step: 'details', severity: 'blocking' }),
    );
  });

  it('a missing subject', () => {
    const issues = preflight(input({ campaign: { ...input().campaign, subjectOverride: null } }));
    expect(issues.some((i) => i.step === 'details' && i.message.includes('subject'))).toBe(true);
  });

  it('no list and no segment', () => {
    const issues = preflight(
      input({ campaign: { ...input().campaign, audience: { listIds: [], segmentIds: [] } } }),
    );

    expect(issues).toContainEqual(
      expect.objectContaining({ step: 'audience', severity: 'blocking' }),
    );
  });

  it('accepts a segment with no list', () => {
    const issues = preflight(
      input({ campaign: { ...input().campaign, audience: { listIds: [], segmentIds: ['s1'] } } }),
    );

    expect(issues.filter((i) => i.step === 'audience' && i.severity === 'blocking')).toEqual([]);
  });

  it('an audience that is entirely suppressed', () => {
    // Distinguished from an empty one, because the customer can act on it.
    const issues = preflight(input({ audienceCount: { eligible: 0, suppressed: 4000 } }));
    const audience = issues.find((i) => i.step === 'audience');

    expect(audience?.severity).toBe('blocking');
    expect(audience?.message).toContain('suppressed');
  });

  it('an audience that is simply empty', () => {
    const issues = preflight(input({ audienceCount: { eligible: 0, suppressed: 0 } }));
    expect(issues.find((i) => i.step === 'audience')?.message).toContain('no contacts');
  });

  it('no template', () => {
    const issues = preflight(input({ campaign: { ...input().campaign, templateVersionId: null } }));
    expect(issues).toContainEqual(
      expect.objectContaining({ step: 'template', severity: 'blocking' }),
    );
  });

  it('neither a sender nor a pool', () => {
    const issues = preflight(
      input({ campaign: { ...input().campaign, senderAccountId: null, sendingPoolId: null } }),
    );

    expect(issues).toContainEqual(
      expect.objectContaining({ step: 'sender', severity: 'blocking' }),
    );
  });

  it('a pool with no single sender is fine', () => {
    const issues = preflight(
      input({ campaign: { ...input().campaign, senderAccountId: null, sendingPoolId: 'pool-1' } }),
    );

    expect(issues.filter((i) => i.step === 'sender')).toEqual([]);
  });

  it('a sender whose identity is not verified', () => {
    const issues = preflight(input({ senderVerified: false }));
    expect(issues.find((i) => i.step === 'sender')?.severity).toBe('blocking');
  });

  it('says nothing about verification it has not checked', () => {
    // `null` means unknown, not bad. Claiming a sender is unverified on no
    // evidence sends the author to fix something that is not broken.
    expect(preflight(input({ senderVerified: null })).filter((i) => i.step === 'sender')).toEqual([]);
  });
});

describe('what only warns', () => {
  it('some suppression, which is normal and healthy', () => {
    // Refusing to send because any suppression exists would make the product
    // unusable within a month of launch.
    const issues = preflight(input({ audienceCount: { eligible: 900, suppressed: 100 } }));
    const audience = issues.find((i) => i.step === 'audience');

    expect(audience?.severity).toBe('warning');
    expect(audience?.message).toContain('100');
  });

  it('a merge tag not every contact can satisfy', () => {
    // The tag has a default, so the send is correct — just less personal than
    // the author expects, and they should learn that before rather than after.
    const issues = preflight(input({ unsatisfiableMergeTags: ['company'] }));
    const tag = issues.find((i) => i.step === 'template');

    expect(tag?.severity).toBe('warning');
    expect(tag?.message).toContain('company');
  });

  it('does not block a launch', () => {
    const issues = preflight(
      input({ audienceCount: { eligible: 900, suppressed: 100 }, unsatisfiableMergeTags: ['x'] }),
    );

    expect(canLaunch(issues)).toBe(true);
  });
});

describe('where the wizard points the author', () => {
  it('marks only the steps with a blocking problem', () => {
    const issues = preflight(
      input({
        campaign: { ...input().campaign, name: '', templateVersionId: null },
        audienceCount: { eligible: 900, suppressed: 100 },
      }),
    );

    // The audience warning must not put a dot on the audience step: a step
    // marked as broken when nothing is broken teaches authors to ignore dots.
    expect(stepsWithIssues(issues)).toEqual(new Set(['details', 'template']));
  });

  it('marks nothing when a campaign is ready', () => {
    expect(stepsWithIssues(preflight(input())).size).toBe(0);
  });

  it('names a step that exists', () => {
    const keys = new Set(WIZARD_STEPS.map((step) => step.key));

    const issues = preflight(
      input({
        campaign: {
          name: '',
          subjectOverride: null,
          templateVersionId: null,
          senderAccountId: null,
          sendingPoolId: null,
          audience: {},
        },
        audienceCount: null,
      }),
    );

    for (const issue of issues) expect(keys, issue.message).toContain(issue.step);
  });
});

describe('the seven steps', () => {
  it('are seven', () => {
    expect(WIZARD_STEPS).toHaveLength(7);
  });

  it('put audience before content', () => {
    // The merge tags an author can use depend on what the audience has.
    const order = WIZARD_STEPS.map((step) => step.key);
    expect(order.indexOf('audience')).toBeLessThan(order.indexOf('template'));
  });

  it('put review last', () => {
    expect(WIZARD_STEPS.at(-1)?.key).toBe('review');
  });

  it('have unique keys', () => {
    const keys = WIZARD_STEPS.map((step) => step.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('editability', () => {
  it('allows a draft and a scheduled campaign', () => {
    expect(isEditable('draft')).toBe(true);
    expect(isEditable('scheduled')).toBe(true);
  });

  it('refuses everything past that', () => {
    // A launched campaign has a snapshot and a pinned template behind it.
    // Letting the author type into fields whose save the server will reject
    // is worse than showing the campaign read-only.
    for (const status of [
      'validating',
      'queueing',
      'sending',
      'pausing',
      'paused',
      'cancelling',
      'cancelled',
      'completed',
      'completed_with_errors',
      'held',
      'failed',
    ] as CampaignStatus[]) {
      expect(isEditable(status), status).toBe(false);
    }
  });
});

describe('polling', () => {
  it('stops entirely for a terminal campaign', () => {
    // A dashboard left open overnight on a completed campaign should cost
    // nothing.
    for (const status of ['completed', 'completed_with_errors', 'cancelled', 'failed'] as const) {
      expect(pollIntervalFor(status), status).toBe(false);
    }
  });

  it('polls fastest while something is mid-flight', () => {
    for (const status of ['validating', 'queueing', 'sending', 'pausing', 'cancelling'] as const) {
      expect(pollIntervalFor(status), status).toBe(2_000);
    }
  });

  it('polls slowly for a campaign that is merely waiting', () => {
    expect(pollIntervalFor('draft')).toBe(5_000);
    expect(pollIntervalFor('paused')).toBe(5_000);
    expect(pollIntervalFor('held')).toBe(5_000);
  });

  it('keeps polling a held campaign, because it resumes by itself', () => {
    // The whole reason `held` is not `paused`. Stopping the poll would leave
    // the page showing "on hold" after it had started sending again.
    expect(pollIntervalFor('held')).not.toBe(false);
  });
});

describe('what the UI says about each state', () => {
  it('has a label for every state', () => {
    const states: CampaignStatus[] = [
      'draft', 'scheduled', 'validating', 'queueing', 'sending', 'pausing',
      'paused', 'cancelling', 'cancelled', 'completed', 'completed_with_errors',
      'held', 'failed',
    ];

    for (const state of states) expect(STATUS_LABELS[state]?.label, state).toBeTruthy();
  });

  it('explains `held` rather than just naming it', () => {
    // A customer who reads "Held" learns nothing and opens a ticket. One who
    // reads that it resumes by itself does not.
    expect(STATUS_LABELS.held.hint).toContain('resume');
  });

  it('explains that a pause lets in-flight messages finish', () => {
    // Otherwise the mail that arrives after they clicked pause looks like the
    // pause did not work.
    expect(STATUS_LABELS.pausing.hint).toContain('finish');
    expect(STATUS_LABELS.cancelling.hint).toContain('finish');
  });

  it('does not call a partial failure a success', () => {
    expect(STATUS_LABELS.completed_with_errors.label).not.toBe('Completed');
  });
});

/* ------------------------------------------------- the step in the URL -- */

describe('the step named in the URL', () => {
  it('resolves every slug the wizard links to', () => {
    for (const [index, step] of WIZARD_STEPS.entries()) {
      expect(stepIndexFor(step.slug), step.slug).toBe(index);
    }
  });

  it('lands on step one for a slug that means nothing', () => {
    // The URL is shareable, so a truncated paste is a normal way to arrive.
    // An error page here would lose a half-written campaign to a bad link.
    expect(stepIndexFor('audienec')).toBe(0);
    expect(stepIndexFor(undefined)).toBe(0);
  });

  it('gives every step a distinct slug', () => {
    const slugs = WIZARD_STEPS.map((step) => step.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("uses the design's labels, in the design's order", () => {
    expect(WIZARD_STEPS.map((step) => step.label)).toEqual([
      'Details',
      'Audience',
      'Sender & pool',
      'Content',
      'Tracking & compliance',
      'Schedule',
      'Review',
    ]);
  });
});

/* -------------------------------------------------- the pre-flight badge -- */

function check(outcome: PreflightCheck['outcome'], key: string = outcome): PreflightCheck {
  return { key, outcome, title: key, detail: '' };
}

describe('the pre-flight summary badge', () => {
  it("counts each outcome, in the design's wording", () => {
    const label = preflightSummary([
      check('fail'),
      check('warn'),
      check('pass', 'a'),
      check('pass', 'b'),
    ]).label;

    expect(label).toBe('1 fail · 1 warning · 2 pass');
  });

  it('pluralises warnings but never "pass"', () => {
    expect(preflightSummary([check('warn', 'a'), check('warn', 'b')]).label).toContain('2 warnings');
    expect(preflightSummary([check('pass')]).label).toContain('1 pass');
  });

  it('is danger while anything fails, warning while anything warns', () => {
    expect(preflightSummary([check('fail'), check('warn')]).tone).toBe('danger');
    expect(preflightSummary([check('warn'), check('pass')]).tone).toBe('warning');
    expect(preflightSummary([check('pass')]).tone).toBe('success');
  });
});

/* ------------------------------------------------------ why launch is off -- */

describe('why the launch button is disabled', () => {
  const ready = {
    checks: [check('pass'), check('warn')],
    consentAttested: true,
    canLaunchPermission: true,
    readOnly: false,
  };

  it('is enabled when every check passes and consent is attested', () => {
    // A warning does not block: leaning on one pool member is normal, and a
    // pre-flight that refused every imperfect send would be turned off.
    expect(launchBlockedReason(ready)).toBeNull();
  });

  it('names the failing check first', () => {
    expect(launchBlockedReason({ ...ready, checks: [check('fail')] })).toBe(
      'Clear the failing check first',
    );
  });

  it('names the missing attestation', () => {
    expect(launchBlockedReason({ ...ready, consentAttested: false })).toBe(
      'Confirm consent in step 5',
    );
  });

  it('tells an Editor what happens instead of just refusing', () => {
    // campaign:launch is separate from campaign:write (CLAUDE.md §11). An
    // editor who is only told "no" opens a ticket; one who is told the
    // request goes to an Owner asks the Owner.
    const reason = launchBlockedReason({ ...ready, canLaunchPermission: false });
    expect(reason).toContain('Editors cannot launch');
    expect(reason).toContain('Owner');
  });

  it('puts permission before everything else', () => {
    // An editor looking at a failing check should still be told the thing
    // they cannot change, not the thing they can.
    const reason = launchBlockedReason({
      ...ready,
      canLaunchPermission: false,
      checks: [check('fail')],
      consentAttested: false,
    });
    expect(reason).toContain('Editors cannot launch');
  });

  it('refuses a read-only workspace in its own words', () => {
    expect(launchBlockedReason({ ...ready, readOnly: true })).toBe('Workspace is read-only');
  });
});
