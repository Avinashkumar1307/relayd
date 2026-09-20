import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDestructive,
  Drawer,
  Field,
  RadioCard,
  RadioGroup,
  Skeleton,
  fmtCount,
} from '@relayd/ui';
import {
  STRATEGY_OPTIONS,
  poolKeys,
  poolsApi,
  type EligibleSender,
  type PoolStrategy,
} from '../../api/pools.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import { combineHeadroom, guardrail, sharedBy, strategyNote } from './headroom.js';
import { Guardrail, ProviderTile, sentence } from './parts.js';

/**
 * H1b — the pool drawer, over the list.
 *
 * The drawer is a route (`/pools/:id`, `/pools/new`) rather than a piece of
 * the list's state, because "look at this pool" is a thing one person sends
 * another and a refresh should not throw it away.
 *
 * Everything in it recomputes live, and that is the point of the frame: tick
 * a second SES sender and the headroom does **not** double, because the
 * second sender draws on the same connection. The panel says so in the same
 * breath — `guardrail()` swaps its sentence for the specific one the moment a
 * connection is shared. Discovering that here costs a click; discovering it
 * mid-campaign costs a send window.
 */

const MINIMUM_MEMBERS = 2;

export function PoolDrawer({ mode }: { mode: 'create' | 'edit' }) {
  const navigate = useNavigate();
  const params = useParams();
  const queryClient = useQueryClient();
  const { currentWorkspaceId, can } = useAuth();
  const readOnly = useReadOnly();

  const poolId = params['id'] ?? '';
  const editing = mode === 'edit';

  const close = (): void => {
    void navigate('/pools');
  };

  const detail = useQuery({
    queryKey: poolKeys.detail(currentWorkspaceId, poolId),
    queryFn: () => poolsApi.get(poolId),
    enabled: editing && poolId !== '',
  });

  const senders = useQuery({
    // BACKEND PENDING: GET /pools/senders
    queryKey: poolKeys.senders(currentWorkspaceId),
    queryFn: () => poolsApi.eligibleSenders(),
  });

  const [name, setName] = useState('');
  const [strategy, setStrategy] = useState<PoolStrategy>('round_robin');
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Seed the form from the pool once its row arrives, and once only: typing
  // in the name field must survive the list's background refetch.
  useEffect(() => {
    if (!editing || loaded || detail.data === undefined) return;

    setName(detail.data.pool.name);
    setStrategy(detail.data.pool.strategy);
    setPicked(detail.data.members.map((member) => member.senderAccountId));
    setLoaded(true);
  }, [editing, loaded, detail.data]);

  const catalogue = useMemo(() => senders.data ?? [], [senders.data]);

  const selected = useMemo(
    () => catalogue.filter((sender) => picked.includes(sender.id)),
    [catalogue, picked],
  );

  const combined = useMemo(() => combineHeadroom(selected, strategy), [selected, strategy]);

  const writable = can('provider:write') && !readOnly;
  const writeReason = readOnly
    ? 'Workspace is read-only'
    : 'Only Owners and Admins can change sending pools';

  const toggle = (sender: EligibleSender): void => {
    setPicked((current) =>
      current.includes(sender.id)
        ? current.filter((id) => id !== sender.id)
        : [...current, sender.id],
    );
  };

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: poolKeys.scoped(currentWorkspaceId) });
  };

  /**
   * Save is four endpoints, in an order that leaves nothing half-applied that
   * a customer would read as a fault: the pool first (so a create has an id
   * to attach members to), then removals, then additions.
   */
  const save = useMutation({
    mutationFn: async () => {
      const id = editing
        ? poolId
        : (await poolsApi.create({ name: name.trim(), strategy })).id;

      if (editing) {
        const pool = detail.data?.pool;
        if (pool !== undefined && (pool.name !== name.trim() || pool.strategy !== strategy)) {
          await poolsApi.update(id, { name: name.trim(), strategy });
        }

        const before = detail.data?.members.map((member) => member.senderAccountId) ?? [];
        for (const senderId of before.filter((value) => !picked.includes(value))) {
          await poolsApi.removeMember(id, senderId);
        }
        for (const senderId of picked.filter((value) => !before.includes(value))) {
          await poolsApi.addMember(id, { senderAccountId: senderId });
        }
      } else {
        for (const senderId of picked) {
          await poolsApi.addMember(id, { senderAccountId: senderId });
        }
      }
    },
    onSuccess: () => {
      invalidate();
      close();
    },
  });

  const remove = useMutation({
    mutationFn: () => poolsApi.remove(poolId),
    onSuccess: () => {
      invalidate();
      setConfirming(false);
      close();
    },
  });

  const enoughMembers = picked.length >= MINIMUM_MEMBERS;
  const named = name.trim() !== '';
  const canSave = writable && enoughMembers && named;

  const saveReason = !writable
    ? writeReason
    : !named
      ? 'Give the pool a name'
      : !enoughMembers
        ? 'Pick at least two members'
        : 'Save pool';

  // H1b's subtitle is the pool's id and a count, in mono. A new pool has no
  // id yet, so its line is prose and is set as prose.
  const usedBy = detail.data?.pool.usedBy?.length ?? 0;
  const subtitle = editing
    ? `${poolId} · ${usedBy === 1 ? 'used by 1 campaign' : `used by ${usedBy} campaigns`}`
    : 'A pool needs two or more verified senders';

  const pending = editing && (detail.isPending || senders.isPending);

  const footer = (
    <>
      {editing ? (
        <Button
          variant="secondary"
          disabled={!writable}
          {...(writable ? {} : { title: writeReason })}
          onClick={() => setConfirming(true)}
        >
          {/* H1b draws this as a secondary button with danger *text*, which
              `Button` has no variant for: `danger` is the filled red one.
              Colouring the label rather than passing a className keeps it
              out of a race with the variant's own `text-text`. */}
          <span className={writable ? 'text-danger-text' : ''}>Delete pool</span>
        </Button>
      ) : (
        <span />
      )}
      <span className="flex gap-2">
        <Button variant="secondary" onClick={close}>
          Cancel
        </Button>
        <Button
          disabled={!canSave}
          pending={save.isPending}
          title={saveReason}
          onClick={() => save.mutate()}
        >
          {editing ? 'Save pool' : 'Create pool'}
        </Button>
      </span>
    </>
  );

  return (
    <>
      <Drawer
        open
        onClose={close}
        size="lg"
        title={editing ? 'Edit pool' : 'Create pool'}
        subtitle={editing ? <span className="font-mono">{subtitle}</span> : subtitle}
        footer={footer}
      >
        {pending ? (
          <div className="flex flex-col gap-4">
            <Skeleton height={36} />
            <Skeleton height={92} />
            <Skeleton height={240} />
          </div>
        ) : (
          <div className="flex flex-col gap-4.5">
            {save.isError ? (
              <p role="alert" className="m-0 text-caption text-danger-text">
                {sentence(save.error)}
              </p>
            ) : null}

            <Field
              label="Pool name"
              value={name}
              disabled={!writable}
              onChange={(event) => setName(event.target.value)}
            />

            <RadioGroup
              label="Strategy"
              orientation="horizontal"
              value={strategy}
              disabled={!writable}
              onChange={(value) => setStrategy(value as PoolStrategy)}
            >
              {STRATEGY_OPTIONS.map((option) => (
                <RadioCard
                  key={option.value}
                  value={option.value}
                  label={option.label}
                  description={option.description}
                  className="min-w-50 flex-1 basis-0"
                />
              ))}
            </RadioGroup>

            <div className="flex flex-col gap-1.5">
              <span className="font-medium">
                Members{' '}
                <span className="font-normal text-text-2">
                  · {picked.length} of {catalogue.length} verified senders
                </span>
              </span>

              <div className="overflow-hidden rounded-control border border-border">
                {catalogue.length === 0 ? (
                  <p className="m-0 px-3.5 py-4 text-caption text-text-2">
                    No verified senders yet. Verify a sender before building a pool.
                  </p>
                ) : (
                  catalogue.map((sender) => (
                    <MemberRow
                      key={sender.id}
                      sender={sender}
                      checked={picked.includes(sender.id)}
                      disabled={!writable || (sender.blockedReason ?? null) !== null}
                      {...(writable ? {} : { reason: writeReason })}
                      onToggle={() => toggle(sender)}
                    />
                  ))
                )}
              </div>
            </div>

            <div className="rounded-control border border-border bg-tint px-4 py-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">Combined headroom</span>
                <span className="text-caption text-text-2">{strategyNote(strategy)}</span>
              </div>

              <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
                <span className="text-title leading-heading font-semibold tracking-heading tabular-nums">
                  {fmtCount(combined.remaining)}
                </span>
                <span className="text-ui text-text-2">
                  emails left today · {combined.perSecond} /s
                </span>
              </div>

              <div className="mt-2.5 flex flex-col gap-1.5 text-caption">
                {combined.connections.map((share) => (
                  <div key={share.id} className="flex justify-between gap-2">
                    <span className="min-w-0 text-text-2">
                      {share.label} · {sharedBy(share.senderCount)}
                    </span>
                    <span className="flex-none tabular-nums">
                      {fmtCount(share.remaining)} left · {share.perSecond} /s
                    </span>
                  </div>
                ))}
              </div>

              <Guardrail inset>{guardrail(combined.shared)}</Guardrail>
            </div>
          </div>
        )}
      </Drawer>

      <ConfirmDestructive
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => remove.mutate()}
        title="Delete this pool?"
        confirmLabel="Delete pool"
        pending={remove.isPending}
      >
        <p className="m-0 text-ui text-text-2">
          {name} is removed from the senders it groups; the senders themselves and everything they
          have sent are untouched. A campaign that still names this pool keeps it, so deleting it
          may be refused.
        </p>
      </ConfirmDestructive>
    </>
  );
}

/**
 * One row of the member list.
 *
 * The whole row is the checkbox's label, so the click target is the row —
 * which is what the frame draws and what a list of five addresses needs.
 * `Checkbox` wraps its label in a plain `<span>`, so the two arbitrary
 * variants below are what let that span stretch and hold a right-aligned
 * rate column. See `uiGaps` in the section report.
 */
function MemberRow({
  sender,
  checked,
  disabled,
  reason,
  onToggle,
}: {
  sender: EligibleSender;
  checked: boolean;
  disabled: boolean;
  reason?: string | undefined;
  onToggle: () => void;
}) {
  const blocked = sender.blockedReason ?? null;

  return (
    <Checkbox
      size="sm"
      checked={checked}
      disabled={disabled}
      onChange={onToggle}
      {...(reason === undefined ? {} : { title: reason })}
      className={[
        'items-center gap-3 border-b border-border px-3.5 py-2.5',
        '[&>span:last-child]:min-w-0 [&>span:last-child]:flex-1',
        checked ? 'bg-brand-soft' : '',
        blocked === null ? '' : 'opacity-55',
      ].join(' ')}
      label={
        <span className="flex items-center gap-3">
          <ProviderTile monogram={sender.monogram} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{sender.email}</span>
            <span className="block text-caption text-text-2">{sender.connectionLabel}</span>
          </span>
          <span className="flex-none text-right text-caption text-text-2 whitespace-nowrap">
            <span className="block text-text tabular-nums">{sender.perSecond} /s</span>
            <span className="block tabular-nums">{fmtCount(sender.remainingToday)} left today</span>
          </span>
          {blocked === null ? null : (
            <span className="flex-none">
              <Badge tone="warning" pulse>
                {blocked}
              </Badge>
            </span>
          )}
        </span>
      }
    />
  );
}
