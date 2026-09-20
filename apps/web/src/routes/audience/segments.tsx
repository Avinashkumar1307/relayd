import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import type { SegmentNode } from '@relayd/audience/browser';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  TableSkeleton,
  type Column,
  type IconName,
} from '@relayd/ui';
import { ApiError } from '../../api/client.js';
import { audienceApi, audienceKeys } from '../../api/audience.js';
import { segmentApi, segmentKeys, type Segment } from '../../api/segments.js';
import { IfPermitted } from '../../auth/guards.js';
import { useReadOnly } from '../../auth/workspace-state.js';

/**
 * Segments (design/D Audience.dc.html — D5a the list, D5b the builder, D5e
 * empty, D5f error).
 *
 * The builder is a *fixed* predicate editor, not a query builder. docs/02:
 * "Segments are stored as a validated JSON AST and compiled to SQL
 * server-side. Never store user SQL." Everything a user can express here
 * lands on one of the leaves in `@relayd/audience/browser`'s AST, and the
 * footnote under the editor says so in as many words — it is the frame's own
 * copy, and it is a promise about the security model, not a limitation to
 * apologise for.
 *
 * Groups are OR'd, rows inside a group are AND'd. That is the whole
 * structure: two levels, no nesting control, which is what keeps the AST
 * under its depth cap without the editor ever having to mention one.
 */

/* ------------------------------------------------------------------ */
/* The predicate vocabulary                                            */
/* ------------------------------------------------------------------ */

/** The operator words are the frame's, verbatim, including the separator. */
export type Operator =
  | 'is'
  | 'is any of'
  | 'is not'
  | 'contains'
  | 'includes'
  | 'does not include'
  | 'within · days'
  | 'more than · days ago';

type FieldKind = 'text' | 'chips' | 'days';

interface FieldDef {
  key: string;
  label: string;
  icon: IconName;
  kind: FieldKind;
  operators: readonly Operator[];
  /** Where a chips field gets its options. */
  options?: 'tags' | 'lists' | 'statuses';
  /** The jsonb key an `attr` leaf addresses. */
  path?: string;
  /**
   * True when the AST has no leaf of its own for this field and it is
   * serialised as an `attr` against the path above.
   */
  pending?: boolean;
}

const TEXT_OPS: readonly Operator[] = ['is', 'is any of', 'is not', 'contains'];
const DAY_OPS: readonly Operator[] = ['within · days', 'more than · days ago'];

/**
 * The field list, in the order the frame's footnote reads it out.
 *
 * BACKEND PENDING: the four fields marked `pending` have no leaf in the
 * segment AST (`packages/audience/src/segments/ast.ts`) and are serialised
 * as `attr` nodes against the paths below. Last engaged, created and
 * consent source each need a first-class leaf and an index before a saved
 * segment using them counts the right people.
 */
export const SEGMENT_FIELDS: readonly FieldDef[] = [
  { key: 'email_domain', label: 'Email domain', icon: 'contacts', kind: 'text', operators: ['is', 'is any of', 'is not'] },
  { key: 'name', label: 'Name', icon: 'contacts', kind: 'text', operators: ['contains', 'is'], path: 'name', pending: true },
  { key: 'country', label: 'Country', icon: 'workspace', kind: 'text', operators: TEXT_OPS, path: 'country' },
  { key: 'language', label: 'Language', icon: 'workspace', kind: 'text', operators: TEXT_OPS, path: 'language' },
  { key: 'tag', label: 'Tag', icon: 'tags', kind: 'chips', operators: ['is', 'is any of', 'is not'], options: 'tags' },
  { key: 'list', label: 'List', icon: 'lists', kind: 'chips', operators: ['includes', 'does not include'], options: 'lists' },
  { key: 'status', label: 'Status', icon: 'contacts', kind: 'chips', operators: ['is', 'is not'], options: 'statuses' },
  { key: 'last_engaged', label: 'Last engaged', icon: 'workspace', kind: 'days', operators: DAY_OPS, path: 'last_engaged_at', pending: true },
  { key: 'created', label: 'Created', icon: 'workspace', kind: 'days', operators: DAY_OPS, path: 'created_at', pending: true },
  { key: 'consent_source', label: 'Consent source', icon: 'workspace', kind: 'text', operators: ['is', 'is any of'], path: 'consent_source', pending: true },
  { key: 'attr', label: 'Custom attribute', icon: 'workspace', kind: 'text', operators: TEXT_OPS },
];

const FIELD_BY_KEY = new Map(SEGMENT_FIELDS.map((field) => [field.key, field]));

function fieldFor(key: string): FieldDef {
  return FIELD_BY_KEY.get(key) ?? (SEGMENT_FIELDS[0] as FieldDef);
}

/** The subscription statuses, as the frames word them. */
const STATUS_OPTIONS: readonly (readonly [string, string])[] = [
  ['subscribed', 'Subscribed'],
  ['unsubscribed', 'Unsubscribed'],
  ['bounced', 'Bounced'],
  ['complained', 'Complained'],
  ['cleaned', 'Cleaned'],
];

export interface PredicateRow {
  id: string;
  field: string;
  /** The attribute name, when `field` is `attr`. */
  attribute: string;
  operator: Operator;
  values: string[];
}

export interface PredicateGroup {
  id: string;
  rows: PredicateRow[];
}

let nextLocalId = 0;
const localId = (prefix: string): string => `${prefix}-${(nextLocalId += 1)}`;

export function emptyRow(field = 'country'): PredicateRow {
  const definition = fieldFor(field);
  return {
    id: localId('row'),
    field,
    attribute: '',
    operator: definition.operators[0] as Operator,
    values: [],
  };
}

export function emptyGroup(): PredicateGroup {
  return { id: localId('group'), rows: [emptyRow()] };
}

/* ------------------------------------------------------------------ */
/* Predicate rows <-> the segment AST                                  */
/* ------------------------------------------------------------------ */

const NEGATED: ReadonlySet<Operator> = new Set<Operator>(['is not', 'does not include']);

function comparatorFor(row: PredicateRow): 'eq' | 'contains' | 'gt' | 'lt' {
  if (row.operator === 'contains') return 'contains';
  // "within 90 days" is a timestamp newer than 90 days ago; "more than 60
  // days ago" is one older. The value is the number of days either way, and
  // the compiler is the thing that turns it into a date.
  if (row.operator === 'within · days') return 'gt';
  if (row.operator === 'more than · days ago') return 'lt';
  return 'eq';
}

function leafFor(row: PredicateRow, value: string): SegmentNode | null {
  const field = fieldFor(row.field);

  switch (field.key) {
    case 'email_domain':
      return { op: 'domain', value };
    case 'tag':
      return { op: 'has_tag', tagId: value };
    case 'list':
      return { op: 'in_list', listId: value };
    case 'status':
      return { op: 'status', value: value as 'subscribed' };
    case 'attr': {
      const path = row.attribute.trim();
      if (path === '') return null;
      return { op: 'attr', path, cmp: comparatorFor(row), value };
    }
    default: {
      if (field.path === undefined) return null;
      return { op: 'attr', path: field.path, cmp: comparatorFor(row), value };
    }
  }
}

/** A row with nothing filled in is ignored rather than refused. */
function rowToNode(row: PredicateRow): SegmentNode | null {
  const values = row.values.map((value) => value.trim()).filter((value) => value !== '');
  if (values.length === 0) return null;

  const leaves = values.map((value) => leafFor(row, value)).filter((node): node is SegmentNode => node !== null);
  if (leaves.length === 0) return null;

  const first = leaves[0] as SegmentNode;
  const combined: SegmentNode = leaves.length === 1 ? first : { op: 'or', children: leaves };

  return NEGATED.has(row.operator) ? { op: 'not', child: combined } : combined;
}

/** The definition the preview and the save both send. Null when empty. */
export function toDefinition(groups: readonly PredicateGroup[]): SegmentNode | null {
  const built = groups
    .map((group) => {
      const children = group.rows.map(rowToNode).filter((node): node is SegmentNode => node !== null);
      if (children.length === 0) return null;
      const first = children[0] as SegmentNode;
      return children.length === 1 ? first : ({ op: 'and', children } as SegmentNode);
    })
    .filter((node): node is SegmentNode => node !== null);

  if (built.length === 0) return null;
  const first = built[0] as SegmentNode;
  return built.length === 1 ? first : { op: 'or', children: built };
}

function fieldKeyForLeaf(leaf: SegmentNode): { field: string; attribute: string } | null {
  switch (leaf.op) {
    case 'domain':
      return { field: 'email_domain', attribute: '' };
    case 'has_tag':
      return { field: 'tag', attribute: '' };
    case 'in_list':
      return { field: 'list', attribute: '' };
    case 'status':
      return { field: 'status', attribute: '' };
    case 'attr': {
      const named = SEGMENT_FIELDS.find((field) => field.path === leaf.path);
      return named === undefined ? { field: 'attr', attribute: leaf.path } : { field: named.key, attribute: '' };
    }
    default:
      return null;
  }
}

function valueOfLeaf(leaf: SegmentNode): string | null {
  switch (leaf.op) {
    case 'domain':
    case 'status':
      return leaf.value;
    case 'has_tag':
      return leaf.tagId;
    case 'in_list':
      return leaf.listId;
    case 'attr':
      return leaf.value === undefined ? null : String(leaf.value);
    default:
      return null;
  }
}

function operatorForLeaf(field: FieldDef, leaf: SegmentNode, many: boolean, negated: boolean): Operator {
  if (field.kind === 'days' && leaf.op === 'attr') {
    return leaf.cmp === 'lt' ? 'more than · days ago' : 'within · days';
  }
  if (negated) return field.key === 'list' ? 'does not include' : 'is not';
  if (field.key === 'list') return 'includes';
  if (leaf.op === 'attr' && leaf.cmp === 'contains') return 'contains';
  return many ? 'is any of' : 'is';
}

function nodeToRow(node: SegmentNode): PredicateRow | null {
  const negated = node.op === 'not';
  const inner = node.op === 'not' ? node.child : node;
  const leaves = inner.op === 'or' ? inner.children : [inner];

  const first = leaves[0];
  if (first === undefined) return null;

  const identity = fieldKeyForLeaf(first);
  if (identity === null) return null;
  // A mixed OR ("country DE or tag VIP") is a shape this editor cannot
  // draw, so it is refused rather than shown as something it is not.
  if (!leaves.every((leaf) => leaf.op === first.op)) return null;

  const values = leaves.map(valueOfLeaf);
  if (values.some((value) => value === null)) return null;

  const field = fieldFor(identity.field);

  return {
    id: localId('row'),
    field: identity.field,
    attribute: identity.attribute,
    operator: operatorForLeaf(field, first, leaves.length > 1, negated),
    values: values as string[],
  };
}

/**
 * Reads a saved definition back into rows.
 *
 * Returns null when the AST is a shape the fixed editor cannot draw — a
 * definition written by the API, or one from a future field set. The caller
 * then says so rather than silently dropping conditions, which is the one
 * outcome that would let somebody save a narrower audience than they had.
 */
export function fromDefinition(definition: SegmentNode | null | undefined): PredicateGroup[] | null {
  if (definition === null || definition === undefined) return null;

  const groupNodes = definition.op === 'or' ? definition.children : [definition];

  const groups: PredicateGroup[] = [];
  for (const groupNode of groupNodes) {
    const rowNodes = groupNode.op === 'and' ? groupNode.children : [groupNode];
    const rows: PredicateRow[] = [];
    for (const rowNode of rowNodes) {
      const row = nodeToRow(rowNode);
      if (row === null) return null;
      rows.push(row);
    }
    groups.push({ id: localId('group'), rows });
  }

  return groups.length === 0 ? null : groups;
}

/* ------------------------------------------------------------------ */
/* Describing a row in words — the D5a "Rules" chips                   */
/* ------------------------------------------------------------------ */

export type NameLookup = (kind: 'tags' | 'lists' | 'statuses', id: string) => string;

const plainLookup: NameLookup = (_kind, id) => id;

export function describeRow(row: PredicateRow, lookup: NameLookup = plainLookup): string {
  const field = fieldFor(row.field);
  const label = field.key === 'attr' ? (row.attribute === '' ? 'Attribute' : row.attribute) : field.label;

  const values = row.values.map((value) =>
    field.options === undefined ? value : lookup(field.options, value),
  );
  const joined = values.join(', ');

  if (row.operator === 'within · days') return `${label} within ${joined} days`;
  if (row.operator === 'more than · days ago') return `${label} more than ${joined} days ago`;

  return `${label} ${row.operator} ${joined}`;
}

/** Every rule in a saved definition, flattened for the list page's chips. */
export function describeDefinition(
  definition: SegmentNode | null | undefined,
  lookup: NameLookup = plainLookup,
): string[] {
  const groups = fromDefinition(definition);
  if (groups === null) return ['Custom rule'];
  return groups.flatMap((group) => group.rows.map((row) => describeRow(row, lookup)));
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const count = (value: number): string => value.toLocaleString('en-US');

/**
 * Month names, spelled out rather than left to `Intl`: `en-GB` abbreviates
 * September as "Sept" and every dated frame in the design says "Sep".
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "18 Sep 2026" — the D5a "Updated" column. */
function shortDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return `${at.getDate()} ${MONTHS[at.getMonth()] ?? ''} ${at.getFullYear()}`;
}

function agoLabel(at: number | undefined): string {
  if (at === undefined || at === 0) return 'Not computed yet';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `Recomputed ${seconds}s ago`;
  if (seconds < 3600) return `Recomputed ${Math.round(seconds / 60)}m ago`;
  return `Recomputed ${Math.round(seconds / 3600)}h ago`;
}

/* ------------------------------------------------------------------ */
/* D5a / D5e / D5f — the list                                          */
/* ------------------------------------------------------------------ */

export function SegmentsPage() {
  const segments = useQuery({ queryKey: segmentKeys.all, queryFn: segmentApi.list });
  const tags = useQuery({ queryKey: audienceKeys.tags, queryFn: audienceApi.listTags });
  const lists = useQuery({ queryKey: audienceKeys.lists, queryFn: audienceApi.listLists });

  const lookup = useNameLookup(tags.data, lists.data);

  const newSegment = (
    <IfPermitted permission="contact:write">
      <Link
        to="/audience/segments/new"
        className="inline-flex h-[34px] items-center gap-1.5 rounded-control bg-brand pr-3 pl-2.5 text-ui font-medium text-on-brand no-underline hover:bg-brand-hover hover:text-on-brand"
      >
        <Icon name="plus" size={15} strokeWidth={2.25} />
        New segment
      </Link>
    </IfPermitted>
  );

  const columns: Column<Segment>[] = [
    {
      key: 'name',
      header: 'Segment',
      width: '20%',
      cell: (segment) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{segment.name}</div>
          <div className="truncate font-mono text-label text-text-3">{segment.id}</div>
        </div>
      ),
    },
    {
      key: 'rules',
      header: 'Rules',
      width: '34%',
      cell: (segment) => (
        <div className="flex flex-wrap items-center gap-1">
          {describeDefinition(segment.definition, lookup).map((rule) => (
            <span
              key={rule}
              className="inline-flex h-5.5 items-center rounded-badge bg-neutral-soft px-2 text-caption whitespace-nowrap text-neutral-text"
            >
              {rule}
            </span>
          ))}
        </div>
      ),
    },
    {
      key: 'count',
      header: 'Est. contacts',
      align: 'right',
      width: '130px',
      cell: (segment) => (
        <span className="tabular-nums">{segment.cachedCount === null ? '—' : count(segment.cachedCount)}</span>
      ),
    },
    {
      key: 'lastUsed',
      header: 'Last used',
      width: '150px',
      // BACKEND PENDING: GET /audience/segments (no last-used join yet).
      cell: (segment) => <span className="block truncate text-text-2">{segment.lastUsedLabel ?? '—'}</span>,
    },
    {
      key: 'updated',
      header: 'Updated',
      width: '150px',
      cell: (segment) => (
        <span className="whitespace-nowrap text-text-2">{shortDate(segment.updatedAt ?? segment.createdAt)}</span>
      ),
    },
    {
      key: 'edit',
      header: '',
      align: 'right',
      width: '90px',
      cell: (segment) => (
        <Link to={`/audience/segments/${segment.id}`} className="text-ui font-medium text-brand no-underline">
          Edit
        </Link>
      ),
    },
  ];

  const header = (description: string) => (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="m-0 text-title leading-heading font-semibold tracking-heading">Segments</h1>
        <p className="mt-1 mb-0 text-body text-text-2">{description}</p>
      </div>
      {newSegment}
    </div>
  );

  if (segments.isPending) {
    return (
      <>
        {header('Rule-based audiences, recomputed when a campaign launches.')}
        <TableSkeleton rows={5} tabs={false} label="Loading segments" />
      </>
    );
  }

  if (segments.isError) {
    return (
      <>
        {header('Rule-based audiences, recomputed when a campaign launches.')}
        <ErrorState
          title="We couldn't load segments"
          description="Scheduled campaigns keep their saved audience. Send support the request ID if it keeps happening."
          requestId={requestIdOf(segments.error)}
          onRetry={() => void segments.refetch()}
          retryLabel="Retry"
          actions={
            <Button variant="secondary" onClick={() => void segments.refetch()}>
              Contact support
            </Button>
          }
        />
      </>
    );
  }

  if (segments.data.length === 0) {
    return (
      <>
        {header('Rule-based audiences, recomputed when a campaign launches.')}
        <EmptyState
          icon="segments"
          title="No segments yet"
          description="Build a segment from fixed rules such as country, tag, list membership and last engagement. Suppressed contacts are always excluded."
          action={
            <IfPermitted permission="contact:write">
              <Link
                to="/audience/segments/new"
                className="inline-flex h-[34px] items-center rounded-control bg-brand px-3 text-ui font-medium text-on-brand no-underline hover:bg-brand-hover hover:text-on-brand"
              >
                New segment
              </Link>
            </IfPermitted>
          }
        />
      </>
    );
  }

  return (
    <>
      {header('Rule-based audiences, recomputed when a campaign launches. Counts are estimates until then.')}
      <DataTable label="Segments" columns={columns} rows={segments.data} rowKey={(segment) => segment.id} />
    </>
  );
}

function requestIdOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.requestId : undefined;
}

function useNameLookup(
  tags: readonly { id: string; name: string }[] | undefined,
  lists: readonly { id: string; name: string }[] | undefined,
): NameLookup {
  return useMemo(() => {
    const byKind = {
      tags: new Map((tags ?? []).map((tag) => [tag.id, tag.name])),
      lists: new Map((lists ?? []).map((list) => [list.id, list.name])),
      statuses: new Map(STATUS_OPTIONS),
    };
    return (kind, id) => byKind[kind].get(id) ?? id;
  }, [tags, lists]);
}

/* ------------------------------------------------------------------ */
/* D5b — the builder                                                   */
/* ------------------------------------------------------------------ */

export function SegmentBuilderPage() {
  const params = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const readOnly = useReadOnly();

  // `/audience/segments/new` is its own route, so `id` is undefined there —
  // but only because React Router ranks the literal above the parameter.
  // Reading the word as well means the page cannot be broken by the order
  // its routes happen to be registered in.
  const segmentId = params['id'] === 'new' ? undefined : params['id'];
  const isNew = segmentId === undefined;

  const segments = useQuery({ queryKey: segmentKeys.all, queryFn: segmentApi.list, enabled: !isNew });
  const tags = useQuery({ queryKey: audienceKeys.tags, queryFn: audienceApi.listTags });
  const lists = useQuery({ queryKey: audienceKeys.lists, queryFn: audienceApi.listLists });
  const lookup = useNameLookup(tags.data, lists.data);

  const saved = isNew ? undefined : segments.data?.find((candidate) => candidate.id === segmentId);

  const [name, setName] = useState('Untitled segment');
  const [groups, setGroups] = useState<PredicateGroup[]>(() => [emptyGroup()]);
  const [dirty, setDirty] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const loaded = useRef<string | null>(null);

  // A saved segment arrives after the first render, so the editor is seeded
  // once the row lands and never again — re-seeding on every render of the
  // list query would throw away whatever had been typed since.
  useEffect(() => {
    if (saved === undefined || loaded.current === saved.id) return;
    loaded.current = saved.id;
    setName(saved.name);
    const parsed = fromDefinition(saved.definition);
    setUnreadable(parsed === null);
    setGroups(parsed ?? [emptyGroup()]);
    setDirty(false);
  }, [saved]);

  const definition = useMemo(() => toDefinition(groups), [groups]);
  const debounced = useDebounced(definition, 400);

  const preview = useQuery({
    queryKey: segmentKeys.preview(debounced),
    queryFn: () => segmentApi.preview(debounced as SegmentNode),
    enabled: debounced !== null,
  });

  const mutate = (next: PredicateGroup[]): void => {
    setGroups(next);
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (definition === null) throw new Error('Add at least one condition');
      return isNew
        ? segmentApi.create({ name, definition })
        : // BACKEND PENDING: PATCH /audience/segments/:id
          segmentApi.update(segmentId, { name, definition });
    },
    onSuccess: (segment) => {
      void queryClient.invalidateQueries({ queryKey: segmentKeys.all });
      setDirty(false);
      void navigate(`/audience/segments/${segment.id}`);
    },
  });

  const discard = (): void => {
    void navigate('/audience/segments');
  };

  const saveBlocked = readOnly || definition === null || save.isPending;
  const saveTitle = readOnly
    ? 'Workspace is read-only'
    : definition === null
      ? 'Add at least one condition'
      : undefined;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to="/audience/segments" className="text-ui font-medium text-brand no-underline">
            ← Segments
          </Link>
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <input
              value={name}
              aria-label="Segment name"
              disabled={readOnly}
              title={readOnly ? 'Workspace is read-only' : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setDirty(true);
              }}
              className="-ml-2.5 h-[38px] w-[520px] max-w-full rounded-control border border-transparent bg-transparent px-2.5 text-title font-semibold tracking-heading text-text outline-none hover:border-border focus:border-border"
            />
            {dirty ? <Badge tone="neutral">Unsaved</Badge> : null}
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Button variant="secondary" onClick={discard}>
            Discard
          </Button>
          <IfPermitted permission="contact:write">
            <Button
              disabled={saveBlocked}
              title={saveTitle}
              pending={save.isPending}
              onClick={() => save.mutate()}
            >
              Save segment
            </Button>
          </IfPermitted>
        </div>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="text-ui text-text-2">
            Contacts match when <span className="font-medium text-text">all</span> conditions in a group are true,
            and <span className="font-medium text-text">any</span> group matches. Suppressed contacts are always
            excluded.
          </div>

          {unreadable ? (
            <div className="flex items-center gap-1.5 rounded-control bg-warning-soft px-2.5 py-2 text-caption text-warning-text">
              <Icon name="alert" size={13} strokeWidth={2} />
              This segment was written with rules this editor cannot draw. Saving would replace them.
            </div>
          ) : null}

          {groups.map((group, index) => (
            <GroupCard
              key={group.id}
              group={group}
              index={index}
              readOnly={readOnly}
              tags={tags.data ?? []}
              lists={lists.data ?? []}
              canRemove={groups.length > 1}
              onChange={(next) => mutate(groups.map((current) => (current.id === group.id ? next : current)))}
              onRemove={() => mutate(groups.filter((current) => current.id !== group.id))}
            />
          ))}

          <div className="flex items-center gap-3">
            <span className="text-caption font-semibold text-text-3">OR</span>
            <button
              type="button"
              disabled={readOnly}
              title={readOnly ? 'Workspace is read-only' : undefined}
              onClick={() => mutate([...groups, emptyGroup()])}
              className="h-[34px] cursor-pointer rounded-control border border-dashed border-border bg-transparent px-3 text-ui font-medium text-text-2 disabled:cursor-not-allowed"
            >
              + Add group
            </button>
          </div>

          <div className="flex items-start gap-1.5 text-caption text-text-2">
            <Icon name="info" size={13} strokeWidth={2} className="mt-0.5 flex-none" />
            Fields: email, name, country, language, tag, list, subscription status, last engaged, created, consent
            source, and custom attributes. No free-form queries.
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <LivePreview
            count={preview.data?.count ?? null}
            capped={preview.data?.capped ?? false}
            cap={preview.data?.cap ?? 10_000}
            subscribedTotal={preview.data?.subscribedTotal}
            computedAt={preview.dataUpdatedAt}
            pending={preview.isFetching}
            failed={preview.isError}
            empty={definition === null}
          />

          {preview.data?.sample === undefined || preview.data.sample.length === 0 ? null : (
            <Card flush>
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <span className="text-ui font-semibold">Sample</span>
                <span className="text-caption text-text-2">
                  {preview.data.sample.length} of {count(Math.min(preview.data.cap, preview.data.count))}
                </span>
              </div>
              {preview.data.sample.map((contact) => (
                <div
                  key={contact.email}
                  className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.25 text-ui last:border-b-0"
                >
                  <span className="min-w-0 truncate">{contact.email}</span>
                  <span className="whitespace-nowrap text-caption text-text-2">{contact.meta}</span>
                </div>
              ))}
            </Card>
          )}

          {save.isError ? (
            <div role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-caption text-danger-text">
              {save.error instanceof Error ? save.error.message : 'That did not save.'}
            </div>
          ) : null}
        </div>
      </div>

      {/* The chip summary the list page will show, so what is being edited
          and what will be read back are visibly the same thing. */}
      <p className="sr-only">{describeDefinition(definition, lookup).join('; ')}</p>
    </>
  );
}

/** Holds a value still for `delay` ms, so typing does not fire a preview a keystroke. */
function useDebounced<T>(value: T, delay: number): T {
  const [held, setHeld] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setHeld(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return held;
}

function LivePreview({
  count: matching,
  capped,
  cap,
  subscribedTotal,
  computedAt,
  pending,
  failed,
  empty,
}: {
  count: number | null;
  capped: boolean;
  cap: number;
  subscribedTotal: number | undefined;
  computedAt: number | undefined;
  pending: boolean;
  failed: boolean;
  empty: boolean;
}) {
  const share =
    matching === null || subscribedTotal === undefined || subscribedTotal === 0
      ? null
      : Math.min(100, (matching / subscribedTotal) * 100);

  return (
    <Card className="px-5 py-4.5">
      <div className="text-ui text-text-2">Live preview</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <span
          aria-live="polite"
          className="text-headline leading-heading font-semibold tracking-heading tabular-nums"
        >
          {empty ? '—' : failed ? '—' : matching === null ? '…' : count(matching)}
        </span>
        <span className="text-ui text-text-2">matching contacts</span>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-3 bg-neutral-soft">
        <div className="h-full rounded-3 bg-brand" style={{ width: `${share ?? 0}%` }} />
      </div>

      <div className="mt-1.5 flex justify-between gap-2 text-caption text-text-2">
        <span>
          {share === null || subscribedTotal === undefined
            ? 'Suppressed contacts are always excluded'
            : `${share.toFixed(1)}% of ${count(subscribedTotal)} subscribed`}
        </span>
        <span>{empty ? 'Add a condition' : pending ? 'Recomputing…' : agoLabel(computedAt)}</span>
      </div>

      {capped && matching !== null ? (
        <div className="mt-3 flex items-start gap-1.5 rounded-control bg-info-soft px-2.5 py-2 text-caption text-info-text">
          <Icon name="info" size={13} strokeWidth={2} className="mt-0.5 flex-none" />
          Preview shows up to {count(cap)} of {count(matching)}. The full audience is computed at launch.
        </div>
      ) : null}

      {failed ? (
        <div className="mt-3 flex items-start gap-1.5 rounded-control bg-danger-soft px-2.5 py-2 text-caption text-danger-text">
          <Icon name="alert" size={13} strokeWidth={2} className="mt-0.5 flex-none" />
          The preview could not be computed. The rules above are still saved as written.
        </div>
      ) : null}
    </Card>
  );
}

function GroupCard({
  group,
  index,
  readOnly,
  tags,
  lists,
  canRemove,
  onChange,
  onRemove,
}: {
  group: PredicateGroup;
  index: number;
  readOnly: boolean;
  tags: readonly { id: string; name: string }[];
  lists: readonly { id: string; name: string }[];
  canRemove: boolean;
  onChange: (group: PredicateGroup) => void;
  onRemove: () => void;
}) {
  const setRows = (rows: PredicateRow[]): void => onChange({ ...group, rows });

  return (
    <Card flush>
      <div className="flex items-center justify-between gap-2 border-b border-border bg-tint px-4 py-2.5 text-caption">
        <span className="font-semibold text-text-2">
          Group {index + 1} <span className="font-normal">· match all (AND)</span>
        </span>
        {canRemove ? (
          <button
            type="button"
            disabled={readOnly}
            title={readOnly ? 'Workspace is read-only' : undefined}
            onClick={onRemove}
            className="h-6.5 cursor-pointer rounded-badge border-0 bg-transparent px-2 text-caption text-text-2 disabled:cursor-not-allowed"
          >
            Remove group
          </button>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 px-4 py-3">
        {group.rows.map((row, rowIndex) => (
          <PredicateRowEditor
            key={row.id}
            row={row}
            prefix={rowIndex === 0 ? 'Where' : 'and'}
            readOnly={readOnly}
            tags={tags}
            lists={lists}
            canRemove={group.rows.length > 1}
            onChange={(next) => setRows(group.rows.map((current) => (current.id === row.id ? next : current)))}
            onRemove={() => setRows(group.rows.filter((current) => current.id !== row.id))}
          />
        ))}

        <div className="sm:pl-13">
          <button
            type="button"
            disabled={readOnly}
            title={readOnly ? 'Workspace is read-only' : undefined}
            onClick={() => setRows([...group.rows, emptyRow()])}
            className="h-7.5 cursor-pointer rounded-control border border-dashed border-border bg-transparent px-2.5 text-caption font-medium text-text-2 disabled:cursor-not-allowed"
          >
            + Add condition
          </button>
        </div>
      </div>
    </Card>
  );
}

/** The 34px bordered box every cell in a predicate row shares. */
const CELL = 'h-[34px] w-full rounded-control border border-border bg-surface text-ui text-text outline-none';

function PredicateRowEditor({
  row,
  prefix,
  readOnly,
  tags,
  lists,
  canRemove,
  onChange,
  onRemove,
}: {
  row: PredicateRow;
  prefix: string;
  readOnly: boolean;
  tags: readonly { id: string; name: string }[];
  lists: readonly { id: string; name: string }[];
  canRemove: boolean;
  onChange: (row: PredicateRow) => void;
  onRemove: () => void;
}) {
  const field = fieldFor(row.field);
  const chipOptions =
    field.options === 'tags'
      ? tags.map((tag) => [tag.id, tag.name] as const)
      : field.options === 'lists'
        ? lists.map((list) => [list.id, list.name] as const)
        : STATUS_OPTIONS;

  const changeField = (key: string): void => {
    const next = fieldFor(key);
    onChange({
      ...row,
      field: key,
      attribute: key === 'attr' ? row.attribute : '',
      operator: next.operators.includes(row.operator) ? row.operator : (next.operators[0] as Operator),
      values: [],
    });
  };

  const readOnlyTitle = readOnly ? 'Workspace is read-only' : undefined;

  return (
    <div className="grid grid-cols-[1fr_32px] items-center gap-2 text-ui sm:grid-cols-[44px_220px_180px_minmax(0,1fr)_32px]">
      <span className="text-caption text-text-3 sm:text-right">{prefix}</span>

      {/* The field's icon sits inside the control, as the frame draws it, so
          the select keeps the platform's own chevron and keyboard handling. */}
      <span className={`${CELL} col-span-2 flex items-center gap-2 pl-3 sm:col-span-1`}>
        <span className="flex-none text-text-3">
          <Icon name={field.icon} size={14} strokeWidth={2} />
        </span>
        <select
          aria-label="Field"
          value={row.field}
          disabled={readOnly}
          title={readOnlyTitle}
          onChange={(event) => changeField(event.target.value)}
          className="h-full min-w-0 flex-1 cursor-pointer border-0 bg-transparent pr-1 text-ui text-text outline-none disabled:cursor-not-allowed"
        >
          {SEGMENT_FIELDS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </span>

      {field.key === 'attr' ? (
        <input
          aria-label="Attribute name"
          value={row.attribute}
          placeholder="loyalty_tier"
          disabled={readOnly}
          title={readOnlyTitle}
          onChange={(event) => onChange({ ...row, attribute: event.target.value })}
          className={`${CELL} col-span-2 px-3 sm:col-span-1 disabled:cursor-not-allowed`}
        />
      ) : (
        <select
          aria-label="Operator"
          value={row.operator}
          disabled={readOnly}
          title={readOnlyTitle}
          onChange={(event) => onChange({ ...row, operator: event.target.value as Operator })}
          className={`${CELL} col-span-2 cursor-pointer px-3 sm:col-span-1 disabled:cursor-not-allowed`}
        >
          {field.operators.map((operator) => (
            <option key={operator} value={operator}>
              {operator}
            </option>
          ))}
        </select>
      )}

      <div className="col-span-2 min-w-0 sm:col-span-1">
        {field.kind === 'chips' ? (
          <ChipValues
            row={row}
            options={chipOptions}
            readOnly={readOnly}
            onChange={(patch) => onChange({ ...row, ...patch })}
          />
        ) : (
          <input
            aria-label="Value"
            value={row.values.join(', ')}
            inputMode={field.kind === 'days' ? 'numeric' : 'text'}
            placeholder={field.kind === 'days' ? '90' : 'DE, FR, BE, NL'}
            disabled={readOnly}
            title={readOnlyTitle}
            onChange={(event) =>
              onChange({
                ...row,
                values: event.target.value
                  .split(',')
                  .map((part) => part.trim())
                  .filter((part) => part !== ''),
              })
            }
            className={`${CELL} px-3 disabled:cursor-not-allowed`}
          />
        )}
      </div>

      <div className="justify-self-end">
        {canRemove ? (
          <button
            type="button"
            disabled={readOnly}
            title={readOnly ? 'Workspace is read-only' : 'Remove condition'}
            aria-label="Remove condition"
            onClick={onRemove}
            className="grid h-8 w-8 cursor-pointer place-items-center rounded-badge border-0 bg-transparent text-text-3 disabled:cursor-not-allowed"
          >
            <Icon name="x" size={14} strokeWidth={2} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The chip value cell: what is chosen, plus one select that adds the next.
 *
 * "+ add" in the frame is a picker, and a native `<select>` is that picker —
 * it brings type-ahead and the platform's own keyboard handling, and there
 * is no popover anywhere in the export to copy instead.
 */
function ChipValues({
  row,
  options,
  readOnly,
  onChange,
}: {
  row: PredicateRow;
  options: readonly (readonly [string, string])[];
  readOnly: boolean;
  onChange: (patch: Partial<PredicateRow>) => void;
}) {
  const label = new Map(options);
  const remaining = options.filter(([value]) => !row.values.includes(value));

  /**
   * Adding a second value to an "is" row makes it an "is any of" row.
   *
   * The AST has no way to say "is exactly these two" — several values on one
   * field are an OR — so the word has to change with the shape, or the rule
   * on screen stops describing what will be counted. Reading a saved
   * definition back applies the same rule (`operatorForLeaf`), so a rule
   * means the same thing before and after it is saved.
   */
  const add = (chosen: string): void => {
    const values = [...row.values, chosen];
    onChange(values.length > 1 && row.operator === 'is' ? { values, operator: 'is any of' } : { values });
  };

  const drop = (value: string): void => {
    const values = row.values.filter((current) => current !== value);
    onChange(values.length < 2 && row.operator === 'is any of' ? { values, operator: 'is' } : { values });
  };

  return (
    <span className="flex min-h-[34px] flex-wrap items-center gap-1.5 rounded-control border border-border bg-surface px-2 py-1">
      {row.values.map((value) => (
        <span
          key={value}
          className="inline-flex h-5.5 items-center gap-1.5 rounded-badge bg-brand-soft px-1.75 text-caption font-medium text-brand"
        >
          {label.get(value) ?? value}
          {readOnly ? null : (
            <button
              type="button"
              aria-label={`Remove ${label.get(value) ?? value}`}
              onClick={() => drop(value)}
              className="cursor-pointer border-0 bg-transparent p-0 text-brand"
            >
              <Icon name="x" size={11} strokeWidth={2.5} />
            </button>
          )}
        </span>
      ))}

      {readOnly || remaining.length === 0 ? null : (
        <select
          aria-label="Add a value"
          value=""
          onChange={(event) => {
            const chosen = event.target.value;
            if (chosen === '') return;
            add(chosen);
          }}
          // appearance-none: the frame's "+ add" is a word, not a dropdown,
          // and the native chevron pushes the chips onto a second line.
          className="cursor-pointer appearance-none border-0 bg-transparent text-caption text-text-3 outline-none"
        >
          <option value="">+ add</option>
          {remaining.map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}
