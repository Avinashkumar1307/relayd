import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Icon, Mono, fmtCount } from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import { billingApi, billingKeys, type Interval } from '../../api/billing.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { ClockGlyph, DetailStrip, StatusCard, formatDate, formatMoney } from './parts.js';

/**
 * I4, I5a/b/c and I6 — the three pages either side of Stripe Checkout.
 *
 * The rule that shapes all of them is CLAUDE.md section 10: the frontend
 * never trusts the checkout redirect. Stripe sends the browser back the
 * instant the card clears, and the webhook that creates the subscription row
 * may not have arrived. So `/billing/success` polls `GET
 * /billing/checkout/status` and shows the customer, honestly, that it is
 * waiting — and when it gives up after about a minute it says the plan has
 * not changed and they have not been charged twice, with a request ID for
 * support. There is no state in which this page claims a subscription it has
 * not seen.
 */

/** The ticking clock on I5a/I5c. One second, the unit the frame prints. */
const TICK_MS = 1000;
/** How often the status endpoint is asked. The server decides when to stop. */
const POLL_MS = 2000;

function Spinner() {
  return (
    <span
      role="presentation"
      className="block h-11 w-11 animate-spin rounded-full border-3 border-brand-soft border-t-brand"
    />
  );
}

/* ------------------------------------------------------------------ I4 */

interface CheckoutHandoffState {
  planCode?: string;
  interval?: Interval;
}

/**
 * I4 — /billing/checkout.
 *
 * A handoff page, not a form. It says where the customer is going, what it
 * will cost today and what it will cost next month, then leaves. It redirects
 * itself once the session exists and keeps a button for when a popup blocker
 * or a slow network means it does not.
 */
export function CheckoutHandoffPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { current } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';

  const state = (location.state ?? {}) as CheckoutHandoffState;
  const planCode = state.planCode ?? '';
  const interval: Interval = state.interval ?? 'month';

  const plans = useQuery({
    queryKey: billingKeys.plans(workspaceId),
    queryFn: () => billingApi.plans(),
  });
  const preview = useQuery({
    queryKey: billingKeys.planChange(workspaceId, planCode),
    queryFn: () => billingApi.planChangePreview(planCode),
    enabled: planCode !== '',
  });

  const plan = plans.data?.find((row) => row.code === planCode);
  const price = plan?.price;
  const amount = price === undefined ? null : interval === 'year' ? price.year : price.month;
  const proration = preview.data?.proration ?? null;

  const [failed, setFailed] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => billingApi.checkout({ planCode, interval }),
    onSuccess: (session) => {
      window.location.assign(session.url);
    },
    onError: (error) => {
      setFailed(error instanceof ApiError ? error.message : 'Checkout could not be started.');
    },
  });

  // One automatic attempt, then the button. Firing on every render would
  // start a Checkout Session per render, and each one is a real object in
  // Stripe.
  const started = useRef(false);
  const begin = start.mutate;
  useEffect(() => {
    if (started.current || planCode === '') return;
    started.current = true;
    begin();
  }, [planCode, begin]);

  if (planCode === '') {
    return (
      <StatusCard
        tone="neutral"
        icon={<Icon name="alert" size={22} strokeWidth={2} />}
        title="Pick a plan first"
        description="This page hands you over to Stripe Checkout for a plan you chose on the plans page. Nothing has been charged."
        actions={
          <Link to="/billing/plans" className="no-underline">
            <Button>See plans</Button>
          </Link>
        }
      />
    );
  }

  return (
    <StatusCard
      tone="brand"
      icon={<Spinner />}
      title={failed === null ? 'Redirecting to secure checkout…' : 'We could not open checkout'}
      description={
        failed === null
          ? `You are leaving Relayd for Stripe Checkout to pay for ${plan?.name ?? 'your new plan'}${proration === null ? '' : `, prorated to ${proration.periodLabel}`}. Relayd never sees your card number. This usually takes a second.`
          : failed
      }
      actions={
        <>
          <Button variant="secondary" onClick={() => navigate('/billing/plans')}>
            Cancel
          </Button>
          <Button onClick={() => start.mutate()} pending={start.isPending}>
            Continue to checkout
          </Button>
        </>
      }
      footnote="If nothing happens in 10 seconds, use the button above."
    >
      <DetailStrip
        rows={[
          {
            label: 'Plan',
            value: `${plan?.name ?? planCode} · ${interval === 'year' ? 'annual' : 'monthly'}`,
          },
          ...(proration === null
            ? []
            : [
                {
                  label: `Due today · prorated ${proration.periodLabel}`,
                  value: formatMoney(proration.dueToday, proration.currency),
                },
              ]),
          ...(amount === null || price === undefined
            ? []
            : [
                {
                  label: `Then from ${preview.data?.effectiveAt === undefined || preview.data.effectiveAt === null ? 'the next renewal' : formatDate(preview.data.effectiveAt)}`,
                  value: `${formatMoney(amount, price.currency)} / month`,
                },
              ]),
        ]}
      />
    </StatusCard>
  );
}

/* --------------------------------------------------------------- I5a-c */

/**
 * I5a / I5b / I5c — /billing/success.
 *
 * Three states of one page: confirming, confirmed, and timed out. The server
 * decides which, from how long we say we have been waiting, so the give-up
 * threshold is not a number somebody has to remember to change here too.
 */
export function CheckoutSuccessPage() {
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const { current, user } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';

  const sessionId = params.get('session_id');
  const startedAt = useRef(Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  const [keepWaiting, setKeepWaiting] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt.current);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const status = useQuery({
    queryKey: billingKeys.checkoutStatus(workspaceId),
    // The elapsed time is deliberately not in the key: it changes every
    // second and would make every tick a cache miss and a new request.
    queryFn: () => billingApi.checkoutStatus(Date.now() - startedAt.current),
    refetchInterval: (query) => {
      const action = query.state.data?.action;
      return action === 'done' || action === 'give_up' ? false : POLL_MS;
    },
  });

  const overview = useQuery({
    queryKey: billingKeys.overview(workspaceId),
    queryFn: () => billingApi.overview(),
  });

  useEffect(() => {
    if (status.data?.ready === true) {
      void queryClient.invalidateQueries({ queryKey: billingKeys.all(workspaceId) });
    }
  }, [status.data?.ready, queryClient, workspaceId]);

  const seconds = Math.floor(elapsedMs / 1000);
  const data = status.data;

  if (data?.ready === true) {
    const emails = overview.data?.usage.find((row) => row.featureKey === 'emails.sent');
    const next = overview.data?.nextInvoice ?? null;

    return (
      <StatusCard
        tone="success"
        icon={<Icon name="check" size={22} strokeWidth={2.25} />}
        title={`${data.planName ?? overview.data?.subscription?.planName ?? 'Your plan'} is active`}
        description={`Confirmed by Stripe${data.confirmedAt === undefined ? '' : ` at ${new Date(data.confirmedAt).toISOString().slice(11, 19)} UTC`}. Your new limits apply now; analytics retention applies to data from today forward.`}
        actions={
          <>
            {data.invoiceUrl === undefined || data.invoiceUrl === null ? null : (
              <a href={data.invoiceUrl} target="_blank" rel="noopener noreferrer" className="no-underline">
                <Button variant="secondary">View invoice</Button>
              </a>
            )}
            <Link to="/billing" className="no-underline">
              <Button>Back to billing</Button>
            </Link>
          </>
        }
      >
        <DetailStrip
          rows={[
            ...(data.chargedToday === undefined
              ? []
              : [
                  {
                    label: 'Charged today · prorated',
                    value: formatMoney(data.chargedToday, data.currency ?? 'usd'),
                  },
                ]),
            ...(next === null
              ? []
              : [
                  {
                    label: 'Next invoice',
                    value: `${formatDate(next.at)} · ${formatMoney(next.total, next.currency)}`,
                  },
                ]),
            ...(emails === undefined
              ? []
              : [
                  {
                    label: 'Emails this period',
                    value: `${fmtCount(emails.used)} / ${emails.included === null ? 'Unlimited' : fmtCount(emails.included)}`,
                  },
                ]),
          ]}
        />
      </StatusCard>
    );
  }

  const gaveUp = data?.action === 'give_up' && keepWaiting === 0;

  if (gaveUp) {
    return (
      <StatusCard
        tone="warning"
        icon={<ClockGlyph />}
        title="We haven't received confirmation yet"
        description={`Stripe reported success, but the confirmation event has not reached us after ${seconds} seconds. Your plan has not changed and you have not been charged twice. This usually resolves within a few minutes; we will email you either way.`}
        actions={
          <>
            <a href="mailto:support@relayd.io" className="no-underline">
              <Button variant="secondary">Contact support</Button>
            </a>
            <Button
              onClick={() => {
                setKeepWaiting((count) => count + 1);
                startedAt.current = Date.now();
                setElapsedMs(0);
                void status.refetch();
              }}
            >
              Keep waiting
            </Button>
          </>
        }
        footnote="Quote the request ID to support; they can see the checkout session."
      >
        <DetailStrip
          rows={[
            { label: 'Waiting for', value: 'Stripe confirmation event' },
            { label: 'Elapsed', value: `${seconds} s` },
            {
              label: 'Plan',
              value: `still ${overview.data?.subscription?.planName ?? 'unchanged'}`,
            },
          ]}
        />

        {data?.requestId === undefined ? null : (
          <Mono value={data.requestId} copy copyLabel="Copy request ID" />
        )}
      </StatusCard>
    );
  }

  return (
    <StatusCard
      tone="brand"
      icon={<Spinner />}
      title="Confirming your subscription…"
      description="Your payment went through on Stripe. We are waiting for the confirmation event before switching the plan, so what you see here is always what you are billed for. Usually under 10 seconds."
      footnote={
        user === null
          ? 'You can leave this page. We will email you when the plan is active.'
          : `You can leave this page. We will email ${user.email} when the plan is active.`
      }
    >
      <DetailStrip
        rows={[
          { label: 'Waiting for', value: 'Stripe confirmation event' },
          { label: 'Elapsed', value: `${seconds} s` },
          ...(sessionId === null
            ? []
            : [
                {
                  label: 'Session',
                  value: (
                    <span className="font-mono">
                      {sessionId.length > 18 ? `${sessionId.slice(0, 12)}…${sessionId.slice(-3)}` : sessionId}
                    </span>
                  ),
                },
              ]),
        ]}
      />
    </StatusCard>
  );
}

/* ------------------------------------------------------------------ I6 */

/** I6 — /billing/cancel. Stripe's own cancel URL. Nothing happened. */
export function CheckoutCancelledPage() {
  const navigate = useNavigate();
  const { current } = useAuth();
  const workspaceId = current?.workspaceId ?? 'none';

  const overview = useQuery({
    queryKey: billingKeys.overview(workspaceId),
    queryFn: () => billingApi.overview(),
  });

  const subscription = overview.data?.subscription ?? null;
  const workspaceName = current?.workspaceName ?? 'This workspace';

  return (
    <StatusCard
      tone="neutral"
      icon={<Icon name="x" size={22} strokeWidth={2} />}
      title="Checkout cancelled"
      description={
        subscription === null
          ? 'No payment was made and nothing changed. You are not on a plan yet.'
          : `No payment was made and nothing changed. ${workspaceName} stays on ${subscription.planName}, renewing ${formatDate(subscription.currentPeriodEnd)}.`
      }
      actions={
        <>
          <Button variant="secondary" onClick={() => navigate('/billing')}>
            Back to billing
          </Button>
          <Button onClick={() => navigate('/billing/plans')}>Try again</Button>
        </>
      }
    />
  );
}
