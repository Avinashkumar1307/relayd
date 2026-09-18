import { describe, expect, it } from 'vitest';
import {
  DELETE_DAY,
  EXPORT_DAY,
  GRACE_DAYS,
  NOTICE_DAYS,
  REQUIRED_DELETION_NOTICES,
  SUSPEND_DAY,
  advanceDunning,
  capabilitiesFor,
  dueNotices,
  dunningStage,
  mayDelete,
  type DunningPort,
  type DunningStage,
} from '../src/dunning/ladder.js';

/**
 * The dunning ladder (docs/05).
 *
 * Two rules are never bent and both are tested at every stage: a running
 * campaign always completes, and scheduled campaigns are held rather than
 * cancelled. The first is about the recipients, who did not fail to pay for
 * anything; the second is about the customer, whose schedule, snapshot and
 * intent do not come back if we throw them away.
 */

const FAILED_AT = new Date('2026-09-01T00:00:00.000Z');

function at(day: number): Date {
  return new Date(FAILED_AT.getTime() + day * 86_400_000);
}

describe('which stage a failure is in', () => {
  it('is current before anything fails', () => {
    expect(dunningStage({ status: 'active', firstFailedAt: null, now: at(0) })).toBe('current');
  });

  it('is past due on day zero', () => {
    expect(dunningStage({ status: 'past_due', firstFailedAt: FAILED_AT, now: at(0) })).toBe(
      'past_due',
    );
  });

  it('stays past due through the grace period', () => {
    expect(dunningStage({ status: 'past_due', firstFailedAt: FAILED_AT, now: at(13) })).toBe(
      'past_due',
    );
  });

  it('restricts the day grace ends', () => {
    expect(dunningStage({ status: 'unpaid', firstFailedAt: FAILED_AT, now: at(GRACE_DAYS) })).toBe(
      'restricted',
    );
  });

  it('suspends at day thirty', () => {
    expect(dunningStage({ status: 'unpaid', firstFailedAt: FAILED_AT, now: at(SUSPEND_DAY) })).toBe(
      'suspended',
    );
  });

  it('opens the export window at day ninety', () => {
    expect(dunningStage({ status: 'unpaid', firstFailedAt: FAILED_AT, now: at(EXPORT_DAY) })).toBe(
      'export_window',
    );
  });

  it('becomes deletable at day one hundred and twenty', () => {
    expect(dunningStage({ status: 'unpaid', firstFailedAt: FAILED_AT, now: at(DELETE_DAY) })).toBe(
      'deletable',
    );
  });

  it('returns to current when a payment succeeds', () => {
    // The clock is gone, not paused. A later failure starts a new one.
    expect(dunningStage({ status: 'active', firstFailedAt: FAILED_AT, now: at(40) })).toBe(
      'current',
    );
  });

  it('treats a trial as current', () => {
    expect(dunningStage({ status: 'trialing', firstFailedAt: FAILED_AT, now: at(40) })).toBe(
      'current',
    );
  });

  it('does not skip ahead on a backwards clock', () => {
    expect(dunningStage({ status: 'past_due', firstFailedAt: at(10), now: FAILED_AT })).toBe(
      'past_due',
    );
  });

  it('is the days docs/05 specifies, not whatever the constants drift to', () => {
    // Pinned to literals. Every boundary test above is written in terms of
    // these constants, so all of them move together if one is edited and
    // nothing notices — which is how a suspension arrives ten days early.
    expect(GRACE_DAYS).toBe(14);
    expect(SUSPEND_DAY).toBe(30);
    expect(EXPORT_DAY).toBe(90);
    expect(DELETE_DAY).toBe(120);
    expect(REQUIRED_DELETION_NOTICES).toBe(3);
  });

  it('uses our clock rather than the provider status alone', () => {
    // Stripe moves to `unpaid` when its own retry schedule is exhausted,
    // which is configured in its dashboard and is not our ladder.
    expect(dunningStage({ status: 'unpaid', firstFailedAt: FAILED_AT, now: at(2) })).toBe(
      'past_due',
    );
  });
});

describe('a running campaign', () => {
  it('completes at every stage', () => {
    // Killing a send mid-flight because a card expired is worse for
    // everybody: the emails are partly out and the recipient experience is
    // broken in a way nobody can explain.
    const stages: DunningStage[] = [
      'current',
      'past_due',
      'restricted',
      'suspended',
      'export_window',
      'deletable',
    ];

    for (const stage of stages) {
      expect(capabilitiesFor(stage).runningCampaigns).toBe('complete');
    }
  });
});

describe('scheduled campaigns', () => {
  it('run while merely past due', () => {
    expect(capabilitiesFor('past_due').scheduledCampaigns).toBe('run');
  });

  it('are held from restriction onwards', () => {
    for (const stage of ['restricted', 'suspended', 'export_window', 'deletable'] as const) {
      expect(capabilitiesFor(stage).scheduledCampaigns).toBe('hold');
    }
  });
});

describe('what each stage permits', () => {
  it('leaves past due almost untouched', () => {
    // Most failures resolve here with a card update. Cutting somebody off at
    // the first failed charge is how a payment blip becomes a churn event.
    expect(capabilitiesFor('past_due')).toMatchObject({
      launchCampaign: true,
      writeContacts: true,
      apiSend: true,
    });
  });

  it('blocks launches once restricted', () => {
    expect(capabilitiesFor('restricted').launchCampaign).toBe(false);
  });

  it('keeps analytics and webhooks alive while restricted', () => {
    expect(capabilitiesFor('restricted')).toMatchObject({
      outboundWebhooks: true,
      analyticsWrites: true,
      apiWrites: true,
    });
  });

  it('refuses API sends while restricted but keeps other writes', () => {
    expect(capabilitiesFor('restricted')).toMatchObject({ apiSend: false, apiWrites: true });
  });

  it('narrows to billing pages when suspended', () => {
    expect(capabilitiesFor('suspended')).toMatchObject({
      apiWrites: false,
      outboundWebhooks: false,
      analyticsWrites: false,
    });
  });

  it('never revokes login', () => {
    // A customer who cannot log in cannot pay.
    for (const stage of [
      'past_due',
      'restricted',
      'suspended',
      'export_window',
      'deletable',
    ] as const) {
      expect(capabilitiesFor(stage).login).toBe(true);
    }
  });

  it('offers the export only from day ninety', () => {
    expect(capabilitiesFor('suspended').exportOffered).toBe(false);
    expect(capabilitiesFor('export_window').exportOffered).toBe(true);
  });
});

describe('notices', () => {
  it('warns before restriction', () => {
    // Day 13. Nothing narrows without the customer having been told it was
    // about to.
    expect(NOTICE_DAYS).toContain(13);
    expect(NOTICE_DAYS).toContain(GRACE_DAYS);
  });

  it('warns before deletion becomes possible', () => {
    expect(NOTICE_DAYS).toContain(85);
  });

  it('sends everything missed, not just today', () => {
    // A worker that did not run for three days must not skip the day-13 final
    // warning and restrict on day 14 with nothing having been said.
    expect(dueNotices({ day: 14, sentDays: [0, 3] })).toEqual([7, 13, 14]);
  });

  it('sends nothing twice', () => {
    expect(dueNotices({ day: 7, sentDays: [0, 3, 7] })).toEqual([]);
  });

  it('sends nothing early', () => {
    expect(dueNotices({ day: 5, sentDays: [0, 3] })).toEqual([]);
  });
});

describe('deletion', () => {
  it('needs the stage, the notices and the export window', () => {
    expect(
      mayDelete({ stage: 'deletable', noticesSent: 3, exportOfferedAt: new Date() }),
    ).toBe(true);
  });

  it('refuses before the stage', () => {
    expect(
      mayDelete({ stage: 'export_window', noticesSent: 8, exportOfferedAt: new Date() }),
    ).toBe(false);
  });

  it('refuses without the notices', () => {
    expect(
      mayDelete({
        stage: 'deletable',
        noticesSent: REQUIRED_DELETION_NOTICES - 1,
        exportOfferedAt: new Date(),
      }),
    ).toBe(false);
  });

  it('refuses without an export window', () => {
    // The customer has to have been offered their data back.
    expect(mayDelete({ stage: 'deletable', noticesSent: 8, exportOfferedAt: null })).toBe(false);
  });
});

function harness(over: Partial<DunningPort> = {}) {
  const calls: string[] = [];
  const notices: number[] = [];
  const stages: DunningStage[] = [];

  const port: DunningPort = {
    async workspacesInDunning() {
      return [];
    },
    async setStage(input) {
      calls.push('set-stage');
      stages.push(input.stage);
      return true;
    },
    async holdScheduledCampaigns() {
      calls.push('hold');
      return 2;
    },
    async releaseHeldCampaigns() {
      calls.push('release');
      return 3;
    },
    async sendNotice(input) {
      calls.push('notice');
      notices.push(input.day);
    },
    async recordEvent() {
      calls.push('event');
    },
    ...over,
  };

  return { port, calls, notices, stages };
}

function workspace(over: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws-1',
    subscriptionId: 'sub-1',
    status: 'past_due',
    firstFailedAt: FAILED_AT,
    stage: 'past_due' as DunningStage,
    noticesSentDays: [0, 3, 7],
    ...over,
  };
}

describe('advancing one workspace', () => {
  it('warns before it narrows', async () => {
    const { port, calls } = harness();

    await advanceDunning(workspace(), at(GRACE_DAYS), port);

    expect(calls.indexOf('notice')).toBeLessThan(calls.indexOf('set-stage'));
  });

  it('holds scheduled campaigns once restricted', async () => {
    const { port, calls } = harness();

    const outcome = await advanceDunning(workspace(), at(GRACE_DAYS), port);

    expect(outcome.stage).toBe('restricted');
    expect(outcome.campaignsHeld).toBe(2);
    expect(calls).toContain('hold');
  });

  it('holds and releases the same campaigns across a failure and a payment', async () => {
    // The round trip is the point. A cancelled campaign has lost its
    // schedule, its snapshot and the customer's intent, and none of that
    // comes back when they pay.
    const { port, calls } = harness();

    await advanceDunning(workspace(), at(GRACE_DAYS), port);
    const paid = await advanceDunning(
      workspace({ status: 'active', stage: 'restricted' }),
      at(GRACE_DAYS + 1),
      port,
    );

    expect(calls.filter((c) => c === 'hold')).toHaveLength(1);
    expect(paid.campaignsReleased).toBeGreaterThan(0);
  });

  it('does not hold while merely past due', async () => {
    const { port, calls } = harness();

    const outcome = await advanceDunning(workspace(), at(5), port);

    expect(outcome.stage).toBe('past_due');
    expect(calls).not.toContain('hold');
  });

  it('records the stage change', async () => {
    const { port, stages } = harness();

    await advanceDunning(workspace(), at(SUSPEND_DAY), port);

    expect(stages).toEqual(['suspended']);
  });

  it('does not rewrite an unchanged stage', async () => {
    const { port, calls } = harness();

    await advanceDunning(workspace({ stage: 'past_due' }), at(5), port);

    expect(calls).not.toContain('set-stage');
  });

  it('still sends the first notice on a backwards clock', async () => {
    // Skew that puts `now` before the failure reads as day -10, and a
    // negative day is before every notice day — so the customer is never told
    // their payment failed at all. Floored to zero instead.
    const { port, notices } = harness();

    await advanceDunning(
      workspace({ firstFailedAt: at(10), noticesSentDays: [] }),
      FAILED_AT,
      port,
    );

    expect(notices).toEqual([0]);
  });

  it('sends every missed notice', async () => {
    const { port, notices } = harness();

    await advanceDunning(workspace({ noticesSentDays: [0] }), at(GRACE_DAYS), port);

    expect(notices).toEqual([3, 7, 13, 14]);
  });
});

describe('when the payment finally arrives', () => {
  it('releases held campaigns', async () => {
    // Automatically. Making the customer re-schedule what we held is a
    // punishment for having paid.
    const { port, calls } = harness();

    const outcome = await advanceDunning(
      workspace({ status: 'active', stage: 'restricted' }),
      at(20),
      port,
    );

    expect(outcome.stage).toBe('current');
    expect(outcome.campaignsReleased).toBe(3);
    expect(calls).toContain('release');
  });

  it('clears the stage', async () => {
    const { port, stages } = harness();

    await advanceDunning(workspace({ status: 'active', stage: 'suspended' }), at(40), port);

    expect(stages).toEqual(['current']);
  });

  it('sends no further notices', async () => {
    const { port, calls } = harness();

    await advanceDunning(workspace({ status: 'active', stage: 'restricted' }), at(40), port);

    expect(calls).not.toContain('notice');
  });

  it('holds nothing', async () => {
    const { port, calls } = harness();

    await advanceDunning(workspace({ status: 'active', stage: 'restricted' }), at(40), port);

    expect(calls).not.toContain('hold');
  });

  it('does nothing noisy for a workspace that was never behind', async () => {
    const { port, calls } = harness();

    await advanceDunning(workspace({ status: 'active', stage: 'current' }), at(1), port);

    expect(calls).toEqual(['release']);
  });
});
