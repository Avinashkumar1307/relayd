import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { Badge, Button, Field, Icon, RevealOnce, type RevealPhase } from '@relayd/ui';
import {
  CONNECTABLE,
  PROVIDER_INFO,
  providerApi,
  providerKeys,
  type ConnectResult,
  type ProviderType,
} from '../../api/providers.js';
import { ApiError } from '../../api/client.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { RequirePermission } from '../../auth/guards.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import { CredentialFields } from './credential-fields.js';
import {
  NoteRow,
  ProviderTile,
  credentialsFrom,
  fmtNumber,
  initialCredentialValues,
} from './provider-ui.js';

/**
 * E1b–E1d — connecting a provider, in three steps on one route.
 *
 * One route rather than three, because the wizard's state is a credential:
 * a step-per-URL wizard either carries the secret in the history entry or
 * re-asks for it, and both are worse than losing the form on a reload.
 *
 * Step three is the only place the inbound webhook URL is ever shown. Its
 * token can write delivery events into this workspace, so there is no
 * endpoint that reads it back — losing it means rotating the connection,
 * which is the correct trade (CLAUDE.md section 11).
 */

const STEPS = ['Choose provider', 'Credentials', 'Delivery events'] as const;

export function ConnectProviderPage() {
  return (
    <RequirePermission permission="provider:write">
      <ConnectWizard />
    </RequirePermission>
  );
}

function ConnectWizard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currentWorkspaceId } = useAuth();
  const readOnly = useReadOnly();
  const workspaceId = currentWorkspaceId ?? 'none';

  const [step, setStep] = useState(0);
  const [type, setType] = useState<ProviderType>('ses');
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string>>(() => initialCredentialValues('ses'));
  const [result, setResult] = useState<ConnectResult | null>(null);

  const credentials = credentialsFrom(type, values);

  const connect = useMutation({
    mutationFn: () => {
      if (credentials === null) throw new Error('Incomplete credentials');
      return providerApi.connect({ providerType: type, name: label.trim(), credentials });
    },
    onSuccess: (connected) => {
      setResult(connected);
      // The credentials leave memory the moment the server has them.
      setValues(initialCredentialValues(type));
      setStep(2);
      void queryClient.invalidateQueries({ queryKey: providerKeys.connections(workspaceId) });
    },
  });

  const chooseProvider = (next: ProviderType) => {
    setType(next);
    setValues(initialCredentialValues(next));
    setStep(1);
  };

  return (
    <div className="mx-auto max-w-[880px]">
      <WizardRail current={step} />

      {step === 0 ? (
        <ChooseProvider onChoose={chooseProvider} />
      ) : step === 1 ? (
        <EnterCredentials
          type={type}
          label={label}
          values={values}
          readOnly={readOnly}
          pending={connect.isPending}
          error={connect.isError ? messageOf(connect.error) : null}
          canSubmit={credentials !== null && label.trim() !== ''}
          onSwitchProvider={(next) => {
            setType(next);
            setValues(initialCredentialValues(next));
            connect.reset();
          }}
          onLabel={setLabel}
          onValue={(name, value) => setValues((previous) => ({ ...previous, [name]: value }))}
          onBack={() => setStep(0)}
          onCancel={() => void navigate('/providers')}
          onSubmit={() => connect.mutate()}
        />
      ) : result === null ? null : (
        <Connected result={result} onDone={() => void navigate('/providers')} />
      )}
    </div>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'The provider rejected these credentials.';
}

// ------------------------------------------------------------------- rail

/**
 * The three-step rail.
 *
 * Horizontal, which the sheet's `Stepper` is not in either variant, so it is
 * drawn here from the same tokens (see uiGaps in the section report).
 */
function WizardRail({ current }: { current: number }) {
  return (
    <ol aria-label="Connect a provider" className="mb-5 flex flex-wrap items-center gap-2 text-ui">
      {STEPS.map((stepLabel, index) => {
        // Only the step you are on is bold. A completed step keeps the filled
        // circle and gives its weight back, so the eye lands on where it is.
        const here = index === current;
        return (
          <li
            key={stepLabel}
            aria-current={index === current ? 'step' : undefined}
            className="flex items-center gap-2"
          >
            {index === 0 ? null : (
              <span aria-hidden="true" className="h-px w-6 bg-border" />
            )}
            <span
              className={[
                'inline-flex items-center gap-2',
                here ? 'font-semibold text-text' : 'font-normal text-text-2',
              ].join(' ')}
            >
              <span
                aria-hidden="true"
                className={[
                  'grid h-[22px] w-[22px] flex-none place-items-center rounded-full text-label font-semibold',
                  index < current
                    ? 'bg-brand text-on-brand'
                    : index === current
                      ? 'bg-brand-soft text-brand'
                      : 'bg-neutral-soft text-text-3',
                ].join(' ')}
              >
                {index + 1}
              </span>
              {stepLabel}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ----------------------------------------------------------------- step 1

function ChooseProvider({ onChoose }: { onChoose: (type: ProviderType) => void }) {
  return (
    <>
      <div className="mb-5">
        <h1 className="m-0 text-title font-semibold leading-heading tracking-heading">
          Which provider will this connection use?
        </h1>
        <p className="mt-1 mb-0 text-body text-text-2">
          You can connect several accounts of the same provider, for example one per region or
          brand.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CONNECTABLE.map((type) => {
          const info = PROVIDER_INFO[type];
          return (
            <button
              key={type}
              type="button"
              onClick={() => onChoose(type)}
              className="cursor-pointer rounded-card border border-border bg-surface p-5 text-left hover:border-brand focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft"
            >
              <ProviderTile type={type} />
              <span className="mt-3.5 block text-card font-semibold leading-heading text-text">
                {info.chooser}
              </span>
              <span className="mt-1 block text-pretty text-ui text-text-2">{info.blurb}</span>
              <span className="mt-3.5 flex flex-col gap-1.5 border-t border-border pt-3 text-caption text-text-2">
                <span>
                  Needs: <span className="text-text">{info.needs}</span>
                </span>
                <span>
                  Delivery feedback: <span className="text-text">{info.feedback}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-5">
        <NoteRow>
          Credentials are encrypted at rest and never shown again after this wizard. Relayd only
          needs permission to send and to receive delivery events.
        </NoteRow>
      </div>
    </>
  );
}

// ----------------------------------------------------------------- step 2

function EnterCredentials({
  type,
  label,
  values,
  readOnly,
  pending,
  error,
  canSubmit,
  onSwitchProvider,
  onLabel,
  onValue,
  onBack,
  onCancel,
  onSubmit,
}: {
  type: ProviderType;
  label: string;
  values: Record<string, string>;
  readOnly: boolean;
  pending: boolean;
  error: string | null;
  canSubmit: boolean;
  onSwitchProvider: (type: ProviderType) => void;
  onLabel: (value: string) => void;
  onValue: (name: string, value: string) => void;
  onBack: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const info = PROVIDER_INFO[type];

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="m-0 text-title font-semibold leading-heading tracking-heading">
            Enter credentials
          </h1>
          <p className="mt-1 mb-0 text-body text-text-2">
            We verify them with a dry-run call before saving.
          </p>
        </div>

        <div
          role="group"
          aria-label="Provider"
          className="inline-flex flex-wrap overflow-hidden rounded-control border border-border text-caption"
        >
          {CONNECTABLE.map((candidate, index) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={candidate === type}
              onClick={() => onSwitchProvider(candidate)}
              className={[
                'h-8 cursor-pointer border-0 px-3 font-medium',
                index === 0 ? '' : 'border-l border-border',
                candidate === type ? 'bg-brand-soft text-brand' : 'bg-surface text-text-2',
              ].join(' ')}
            >
              {PROVIDER_INFO[candidate].label}
            </button>
          ))}
        </div>
      </div>

      <form
        className="flex flex-col gap-4.5 rounded-card border border-border bg-surface p-6 text-ui"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit && !readOnly) onSubmit();
        }}
      >
        <Field
          label="Connection label"
          value={label}
          onChange={(event) => onLabel(event.target.value)}
          placeholder="eu-west-1 · production"
          autoComplete="off"
          disabled={pending}
          help="Shown next to the provider name everywhere in Relayd."
          className="max-w-[420px]"
        />

        <CredentialFields type={type} values={values} disabled={pending} onChange={onValue} />

        <NoteRow variant="tint">{info.note}</NoteRow>

        {error === null ? null : (
          <p role="alert" className="text-ui text-danger-text">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={onBack}
            className="cursor-pointer border-0 bg-transparent p-0 text-ui font-medium text-brand"
          >
            ← Change provider
          </button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              pending={pending}
              disabled={!canSubmit || readOnly}
              title={readOnly ? 'Workspace is read-only' : undefined}
            >
              Verify and connect
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}

// ----------------------------------------------------------------- step 3

/**
 * How to point each provider's console at the URL we just minted.
 *
 * SMTP has no entry: there is no webhook to configure, which is D4 and the
 * reason its card says best-effort everywhere else too.
 */
const WEBHOOK_GUIDE: Partial<Record<ProviderType, { title: string; steps: ReactNode[] }>> = {
  ses: {
    title: 'Paste it into the SES console',
    steps: [
      <>
        In <Strong>Amazon SES → Configuration sets</Strong>, open the set your senders use (or
        create <Code>relayd</Code>).
      </>,
      <>
        Add an <Strong>Event destination</Strong> of type <Strong>Amazon SNS</Strong>; select events{' '}
        <Code>Send, Delivery, Bounce, Complaint, Reject</Code>.
      </>,
      <>
        In the SNS topic, create an <Strong>HTTPS subscription</Strong> with the URL above. Relayd
        confirms the subscription automatically.
      </>,
      <>
        Send a test below. The status on the right flips to <Success>Receiving events</Success> when
        the first event lands.
      </>,
    ],
  },
  sendgrid: {
    title: 'Paste it into the SendGrid dashboard',
    steps: [
      <>
        In <Strong>Settings → Mail Settings → Event Webhook</Strong>, create a webhook and paste the
        URL above as the HTTP POST URL.
      </>,
      <>
        Select events <Code>Processed, Delivered, Bounce, Dropped, Spam Report</Code> and enable
        signed event webhooks.
      </>,
      <>
        Send a test below. The status on the right flips to <Success>Receiving events</Success> when
        the first event lands.
      </>,
    ],
  },
  mailgun: {
    title: 'Paste it into the Mailgun console',
    steps: [
      <>
        In <Strong>Sending → Webhooks</Strong> for this domain, add the URL above for{' '}
        <Code>delivered, permanent_fail, temporary_fail, complained</Code>.
      </>,
      <>Use the same region the sending key belongs to; a webhook in the other region never fires.</>,
      <>
        Send a test below. The status on the right flips to <Success>Receiving events</Success> when
        the first event lands.
      </>,
    ],
  },
  brevo: {
    title: 'Paste it into Brevo',
    steps: [
      <>
        In <Strong>Transactional → Settings → Webhooks</Strong>, add the URL above.
      </>,
      <>
        Select events <Code>delivered, hardBounce, softBounce, spam, blocked</Code>.
      </>,
      <>
        Send a test below. The status on the right flips to <Success>Receiving events</Success> when
        the first event lands.
      </>,
    ],
  },
};

function Strong({ children }: { children: ReactNode }) {
  return <span className="text-text">{children}</span>;
}

function Code({ children }: { children: ReactNode }) {
  return <span className="font-mono text-caption">{children}</span>;
}

function Success({ children }: { children: ReactNode }) {
  return <span className="font-medium text-success-text">{children}</span>;
}

function Connected({ result, onDone }: { result: ConnectResult; onDone: () => void }) {
  const info = PROVIDER_INFO[result.providerType];
  const guide = WEBHOOK_GUIDE[result.providerType];
  const [phase, setPhase] = useState<RevealPhase>('revealed');

  const quota = result.quotaSnapshot?.max24Hour ?? null;
  const rate = result.quotaSnapshot?.maxSendRate ?? null;

  const testEvent = useMutation({
    // BACKEND PENDING: POST /providers/:id/ingest/test
    mutationFn: () => providerApi.sendTestEvent(result.id),
  });

  return (
    <div className="flex flex-col gap-5 rounded-card border border-border bg-surface p-7">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 flex-none place-items-center rounded-10 bg-success-soft text-success-text">
          <Icon name="check" size={20} strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <h1 className="m-0 text-section font-semibold leading-heading">
            {info.label} · {result.name} is connected
          </h1>
          <div className="mt-0.5 text-ui text-text-2">
            Dry-run send succeeded
            {quota === null ? '' : ` · daily quota ${fmtNumber(quota)}`}
            {rate === null ? '' : ` · ${rate} /s`} ·{' '}
            <span className="font-mono text-caption">{result.id}</span>
          </div>
        </div>
      </div>

      {result.warnings.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-1.5 rounded-control bg-warning-soft px-3.5 py-3 pl-3.5 text-ui text-warning-text">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {guide === undefined ? (
        <NoteRow variant="tint">{info.note}</NoteRow>
      ) : (
        <>
          <div className="flex items-start gap-2.5 rounded-control bg-warning-soft px-3.5 py-3 text-ui text-warning-text">
            <span className="mt-0.5 flex-none">
              <Icon name="alert" size={16} strokeWidth={2} />
            </span>
            <span>
              <span className="font-semibold">One more step: delivery events.</span> Without this
              webhook, bounces and complaints will not reach Relayd, and every send will show as
              delivery uncertain. The URL below is shown once; after you leave, only the ID is
              visible and you can rotate it.
            </span>
          </div>

          <RevealOnce
            size="lg"
            label="Inbound webhook URL for this connection"
            masked={result.id}
            secret={result.ingestUrl}
            phase={phase}
            onAcknowledge={() => setPhase('masked')}
            acknowledgeLabel="I've stored it"
            footnote="Only the connection ID is visible now. Rotate the connection to mint a new URL."
          />

          <div>
            <div className="mb-2.5 text-ui font-medium">{guide.title}</div>
            <ol className="m-0 flex list-decimal flex-col gap-2 pl-5 text-ui text-text-2">
              {guide.steps.map((stepNode, index) => (
                <li key={index}>{stepNode}</li>
              ))}
            </ol>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border bg-tint px-3.5 py-3 text-ui">
            <span className="flex flex-wrap items-center gap-2">
              {testEvent.isSuccess ? (
                <Badge tone="success">Test event received</Badge>
              ) : (
                <Badge tone="info" pulse>
                  Waiting for first event
                </Badge>
              )}
              <span className="text-text-2">
                {testEvent.isSuccess
                  ? 'The endpoint answered. Real provider events will land here too.'
                  : 'Listening on this URL · nothing received yet'}
              </span>
            </span>
            <Button
              variant="secondary"
              className="h-8 px-2.5 text-caption"
              pending={testEvent.isPending}
              onClick={() => testEvent.mutate()}
            >
              Send test event
            </Button>
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4.5">
        <Link to="/senders" className="text-ui font-medium text-brand">
          Next: verify a sender on this connection →
        </Link>
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}
