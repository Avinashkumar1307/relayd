import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { normaliseHeader, parseDelimited, toCsvLines } from '@relayd/audience/browser';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  ErrorState,
  Icon,
  TableSkeleton,
  type Column,
} from '@relayd/ui';
import {
  audienceApi,
  audienceKeys,
  type ImportJob,
  type ImportRowError,
  type ImportStatus,
} from '../../api/audience.js';
import { ApiError } from '../../api/client.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { IfPermitted } from '../../auth/guards.js';
import { useReadOnly, useWorkspaceRecord } from '../../auth/workspace-state.js';
import { CONSENT_SOURCE_LABELS, type ConsentSource } from '../../components/consent.js';

/**
 * Importing contacts (design/D Audience.dc.html — D6a upload, D6b map
 * columns, D6c consent, D6d live progress then report, D6e empty, D6f
 * error).
 *
 * Four stages, and the third is the one the whole screen exists for. The
 * frame's own subtitle says it: "Nothing is saved before step 3." The file
 * goes straight to object storage from the browser (a presigned PUT; the
 * alternative holds a 100 MB upload in memory twice), its columns are read
 * here so the mapping form shows exactly what the importer will find, and
 * not a row is written until somebody has attested consent with their name
 * against it.
 *
 * ## BACKEND PENDING
 *
 * Every path this page calls is real and every field it declares on
 * `ImportJob` is served. What is missing is the pre-flight analysis D6b and
 * D6c draw — per-column samples, how many addresses are already known, how
 * many are already suppressed — which is not computed anywhere and has no
 * column on `import_jobs`. Each missing field is named at its declaration
 * on `ImportJobView`; the page reads them when present and degrades to what
 * the browser can work out by itself when they are not.
 */

const ACTIVE: readonly ImportStatus[] = ['pending', 'mapping', 'validating', 'processing'];

/**
 * The import job as D6 draws it.
 *
 * Every added field is optional: `ImportJob` in `api/audience.ts` is the
 * shape the API returns today, and this page has to render correctly
 * against it as well as against the mocked API, which supplies the rest.
 */
export interface ImportColumnAnalysis {
  name: string;
  /** Two or three values from the first rows — D6b's "Sample values". */
  samples: string[];
}

export interface ImportJobView extends ImportJob {
  /**
   * BACKEND PENDING: `GET /imports/:id` has no `encoding`, `rowCount` or
   * `columns` field. Nothing reads the file before the importer runs, so
   * the browser parses the local copy instead. (`byteSize` and `totalRows`
   * are served; `rowCount` is the pre-flight estimate, which is not.)
   */
  encoding?: string;
  rowCount?: number;
  columns?: ImportColumnAnalysis[];
  /**
   * BACKEND PENDING: `GET /imports/:id` has no `invalidEmailCount`,
   * `existingEmailCount`, `suppressedCount`, `contactsAfter` or
   * `contactLimit` field — D6c's pre-flight estimate, which nothing
   * computes.
   */
  invalidEmailCount?: number;
  existingEmailCount?: number;
  suppressedCount?: number;
  contactsAfter?: number;
  contactLimit?: number;
  /**
   * BACKEND PENDING: `GET /imports` has no `attestedBy` or
   * `consentSourceLabel` field. The attestation is recorded
   * (`consent_attestations`, written by `POST /imports/:id/mapping`) but
   * the list does not join it.
   */
  attestedBy?: string;
  consentSourceLabel?: string;
  /**
   * BACKEND PENDING: `GET /imports/:id` has no `etaSeconds` field — D6d's
   * "about 40 seconds left". Nothing measures the importer's rate.
   */
  etaSeconds?: number;
  /**
   * Columns already decided against.
   *
   * BACKEND PENDING: `GET /imports/:id` has no `skippedColumns` field.
   * `columnMapping` cannot say this: a column missing from it is a column
   * nobody has answered for yet, and D6b draws those two differently —
   * amber prompt against greyed row.
   */
  skippedColumns?: string[];
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const count = (value: number): string => value.toLocaleString('en-US');

/**
 * Month names, spelled out rather than left to `Intl`.
 *
 * `en-GB` abbreviates September as "Sept" and the design says "Sep" on every
 * frame that carries a date. The zone is the workspace's, not the reader's:
 * an import that started at 09:31 in Dubai did not start at 05:31, and two
 * people looking at the same history should be reading the same clock.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fields(at: Date, timeZone: string | null): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone === null ? {} : { timeZone }),
  });

  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(at)) out[part.type] = part.value;
  return out;
}

/** "15 Sep 2026, 08:30" — the D6a history column. */
function stamp(iso: string, timeZone: string | null): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';

  const part = fields(at, timeZone);
  const month = MONTHS[Number(part['month']) - 1] ?? '';
  // Number(), because `en-GB` pads the day to two digits once a two-digit
  // hour is asked for, and the design writes "1 Sep 2026, 14:02".
  return `${Number(part['day'])} ${month} ${part['year']}, ${part['hour']}:${part['minute']}`;
}

/** "20 Sep 2026" — the date on the consent attestation. */
function day(at: Date, timeZone: string | null): string {
  const part = fields(at, timeZone);
  return `${Number(part['day'])} ${MONTHS[Number(part['month']) - 1] ?? ''} ${part['year']}`;
}

/** The workspace's zone, or the reader's while the record is loading. */
function useZone(): string | null {
  return useWorkspaceRecord().data?.timezone ?? null;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function joinFacts(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(' · ');
}

/* ------------------------------------------------------------------ */
/* Status vocabulary                                                   */
/* ------------------------------------------------------------------ */

interface StatusLook {
  label: string;
  tone: 'neutral' | 'brand' | 'success' | 'danger';
  pulse?: boolean;
  outline?: boolean;
  dot?: 'warning';
}

/**
 * Above this share of rejected rows, a finished import is "Completed with
 * errors" rather than "Completed".
 *
 * D6a shows both badges: 24 failures in 48,402 rows is Completed, 78 in
 * 9,700 is Completed with errors. A rate, not a count — a handful of bad
 * addresses in a fifty-thousand-row export is the normal case, and a badge
 * that shouts at every import stops being read. The failed count is red in
 * its own column either way.
 */
const ERROR_RATE = 0.005;

/** The words and tones in D6a's history column and D6d's progress badge. */
export function statusLook(
  job: Pick<ImportJob, 'status' | 'failedCount' | 'processedRows' | 'totalRows'>,
): StatusLook {
  switch (job.status) {
    case 'pending':
      return { label: 'Queued', tone: 'neutral' };
    case 'mapping':
      return { label: 'Mapping', tone: 'neutral' };
    case 'validating':
      return { label: 'Validating', tone: 'brand', pulse: true };
    case 'processing':
      return { label: 'Importing', tone: 'brand', pulse: true };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' };
    case 'failed':
      return { label: 'Failed', tone: 'danger' };
    default: {
      const rows = job.totalRows ?? job.processedRows;
      const noisy = job.failedCount > 0 && (rows === 0 || job.failedCount / rows > ERROR_RATE);
      return noisy
        ? { label: 'Completed with errors', tone: 'success', outline: true, dot: 'warning' }
        : { label: 'Completed', tone: 'success' };
    }
  }
}

function StatusBadge({
  job,
}: {
  job: Pick<ImportJob, 'status' | 'failedCount' | 'processedRows' | 'totalRows'>;
}) {
  const look = statusLook(job);
  return (
    <Badge tone={look.tone} pulse={look.pulse} outline={look.outline} dot={look.dot}>
      {look.label}
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/* The four-stage strip (D6a–d)                                        */
/* ------------------------------------------------------------------ */

const STAGES = [
  { title: 'Upload', sub: 'CSV or XLSX' },
  { title: 'Map columns', sub: 'auto-detected' },
  { title: 'Consent', sub: 'required' },
  { title: 'Import', sub: 'live progress' },
] as const;

/**
 * D6's stage strip.
 *
 * Not `@relayd/ui`'s `Stepper`: both of that component's variants are the
 * vertical rail G2 uses, and this is a four-across row of bordered cards
 * with its own bubble states. Reported as a `uiGaps` entry rather than bent
 * into the sheet's component.
 */
function ImportStages({ current }: { current: 0 | 1 | 2 | 3 }) {
  return (
    <ol aria-label="Import stages" className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {STAGES.map((stage, index) => {
        const state = index < current ? 'complete' : index === current ? 'current' : 'upcoming';

        return (
          <li
            key={stage.title}
            aria-current={state === 'current' ? 'step' : undefined}
            className={[
              'flex items-center gap-2.5 rounded-control border px-3 py-2.5',
              state === 'current' ? 'border-brand bg-brand-soft' : 'border-border bg-surface',
              state === 'upcoming' ? 'opacity-70' : '',
            ].join(' ')}
          >
            <span
              aria-hidden="true"
              className={[
                'grid h-6 w-6 flex-none place-items-center rounded-full border text-caption font-semibold',
                state === 'complete'
                  ? 'border-transparent bg-brand text-on-brand'
                  : state === 'current'
                    ? 'border-brand bg-surface text-brand'
                    : 'border-transparent bg-neutral-soft text-text-3',
              ].join(' ')}
            >
              {index + 1}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-ui font-medium">{stage.title}</span>
              <span className="block truncate text-caption text-text-2">{stage.sub}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* The history table, shared by D6a and D6d                            */
/* ------------------------------------------------------------------ */

function ImportHistory({ jobs }: { jobs: readonly ImportJobView[] }) {
  const zone = useZone();
  const columns: Column<ImportJobView>[] = [
    {
      key: 'file',
      header: 'File',
      width: '23%',
      cell: (job) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{job.originalFilename}</div>
          <div className="truncate text-caption text-text-2">
            {joinFacts([
              job.rowCount === undefined ? null : `${count(job.rowCount)} rows`,
              job.consentSourceLabel === undefined ? null : `consent: ${job.consentSourceLabel}`,
            ]) || (job.attestedBy ?? '—')}
          </div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', width: '140px', cell: (job) => <StatusBadge job={job} /> },
    {
      key: 'created',
      header: 'Created',
      align: 'right',
      width: '110px',
      cell: (job) => <span className="tabular-nums">{count(job.createdCount)}</span>,
    },
    {
      key: 'updated',
      header: 'Updated',
      align: 'right',
      width: '110px',
      cell: (job) => <span className="tabular-nums">{count(job.updatedCount)}</span>,
    },
    {
      key: 'skipped',
      header: 'Skipped',
      align: 'right',
      width: '110px',
      cell: (job) => <span className="tabular-nums text-text-2">{count(job.skippedCount)}</span>,
    },
    {
      key: 'failed',
      header: 'Failed',
      align: 'right',
      width: '100px',
      cell: (job) => (
        <span className={job.failedCount > 0 ? 'tabular-nums font-medium text-danger-text' : 'tabular-nums text-text-2'}>
          {count(job.failedCount)}
        </span>
      ),
    },
    {
      key: 'attested',
      header: 'Attested by',
      width: '16%',
      // BACKEND PENDING: GET /imports has no `attestedBy` field.
      cell: (job) => <span className="block truncate text-text-2">{job.attestedBy ?? '—'}</span>,
    },
    {
      key: 'date',
      header: 'Date',
      width: '130px',
      cell: (job) => <span className="whitespace-nowrap text-caption text-text-2">{stamp(job.createdAt, zone)}</span>,
    },
  ];

  return (
    <>
      <div className="mt-7 mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-card leading-heading font-semibold">Import history</h2>
        <span className="text-caption text-text-2">Failed-row files are kept for 30 days</span>
      </div>
      <DataTable
        label="Import history"
        columns={columns}
        rows={jobs}
        rowKey={(job) => job.id}
        onRowClick={undefined}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* D6a–c — /audience/imports                                           */
/* ------------------------------------------------------------------ */

interface Draft {
  job: ImportJobView;
  columns: ImportColumnAnalysis[];
}

type Stage =
  | { name: 'upload' }
  | { name: 'map'; draft: Draft }
  | { name: 'consent'; draft: Draft; mapping: Record<string, string> };

export function ImportsPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [stage, setStage] = useState<Stage>({ name: 'upload' });
  const [forceUpload, setForceUpload] = useState(false);

  /**
   * Picking an import back up.
   *
   * A job sits in `mapping` until somebody attests consent, and the file is
   * already in object storage by then — so the mapping and consent stages
   * have to be reachable without re-uploading it. `?job=<id>` opens stage 2
   * for that job and `&stage=consent` opens stage 3, reading the columns and
   * the detected mapping from the job itself.
   */
  const resumeId = searchParams.get('job');
  const resumeStage = searchParams.get('stage');

  const resumed = useQuery<ImportJobView>({
    queryKey: audienceKeys.import(resumeId ?? ''),
    queryFn: () => audienceApi.getImport(resumeId ?? ''),
    enabled: resumeId !== null,
  });

  const seeded = useRef<string | null>(null);

  useEffect(() => {
    const job = resumed.data;
    if (resumeId === null || job === undefined || seeded.current === resumeId) return;

    seeded.current = resumeId;
    const draft: Draft = { job, columns: job.columns ?? [] };
    setStage(
      resumeStage === 'consent'
        ? { name: 'consent', draft, mapping: job.columnMapping ?? {} }
        : { name: 'map', draft },
    );
  }, [resumeId, resumeStage, resumed.data]);

  const imports = useQuery<ImportJobView[]>({
    queryKey: audienceKeys.imports,
    queryFn: audienceApi.listImports,
    /**
     * Poll only while something is moving. A dashboard left open on a
     * finished page should not keep asking; the interval stops on its own
     * once every job has settled.
     */
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined) return false;
      return data.some((job) => ACTIVE.includes(job.status)) ? 2000 : false;
    },
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: audienceKeys.imports });
  };

  if (stage.name === 'map') {
    return (
      <MapColumnsStage
        draft={stage.draft}
        onBack={() => setStage({ name: 'upload' })}
        onContinue={(mapping) => setStage({ name: 'consent', draft: stage.draft, mapping })}
      />
    );
  }

  if (stage.name === 'consent') {
    return (
      <ConsentStage
        draft={stage.draft}
        mapping={stage.mapping}
        onBack={() => setStage({ name: 'map', draft: stage.draft })}
        onStarted={() => {
          setStage({ name: 'upload' });
          invalidate();
        }}
      />
    );
  }

  const shortHeader = (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="m-0 text-title leading-heading font-semibold tracking-heading">Imports</h1>
        <p className="mt-1 mb-0 text-body text-text-2">Upload, map columns, confirm consent, import.</p>
      </div>
    </div>
  );

  if (imports.isPending) {
    return (
      <>
        {shortHeader}
        <TableSkeleton rows={4} tabs={false} label="Loading import history" />
      </>
    );
  }

  if (imports.isError) {
    return (
      <>
        {shortHeader}
        <ErrorState
          title="We couldn't load import history"
          description="Running imports continue in the background. Send support the request ID if it keeps happening."
          requestId={imports.error instanceof ApiError ? imports.error.requestId : undefined}
          onRetry={() => void imports.refetch()}
          retryLabel="Retry"
          actions={
            <Button variant="secondary" onClick={() => void imports.refetch()}>
              Contact support
            </Button>
          }
        />
      </>
    );
  }

  if (imports.data.length === 0 && !forceUpload) {
    return (
      <>
        {shortHeader}
        <EmptyState
          icon="imports"
          title="No imports yet"
          description="Your first import will appear here with created, updated, skipped and failed counts and a downloadable failed-rows file."
          action={
            <IfPermitted permission="contact:import">
              <Button onClick={() => setForceUpload(true)}>Start an import</Button>
            </IfPermitted>
          }
        />
      </>
    );
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="m-0 text-title leading-heading font-semibold tracking-heading">Import contacts</h1>
          <p className="mt-1 mb-0 text-body text-text-2">
            Upload, map columns, confirm consent, import. Nothing is saved before step 3.
          </p>
        </div>
      </div>

      <ImportStages current={0} />

      <UploadStage onReady={(draft) => setStage({ name: 'map', draft })} />

      {imports.data.length === 0 ? null : <ImportHistory jobs={imports.data} />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Stage 1 — D6a                                                       */
/* ------------------------------------------------------------------ */

const UPLOAD_NOTES = [
  ['Email is the only required column', 'Duplicates in your file and in Relayd are merged, never doubled.'],
  ['Suppressed addresses stay suppressed', 'Unsubscribes, bounces and complaints are not reactivated by an import.'],
  ['You attest consent before saving', 'Your name and the time are recorded in the audit log.'],
] as const;

function UploadStage({ onReady }: { onReady: (draft: Draft) => void }) {
  const readOnly = useReadOnly();
  const { can } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const allowed = can('contact:import') && !readOnly;
  const blockedTitle = readOnly
    ? 'Workspace is read-only'
    : can('contact:import')
      ? undefined
      : 'You need the contact:import permission';

  const handle = async (file: File): Promise<void> => {
    setError(null);
    const fileType = fileTypeOf(file.name);

    if (fileType === null) {
      setError('Choose a .csv, .tsv or .xlsx file.');
      return;
    }

    try {
      setBusy('Creating the import…');
      const created = await audienceApi.createImport({
        filename: file.name,
        byteSize: file.size,
        fileType,
      });

      setBusy('Uploading…');
      const response = await fetch(created.upload.url, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': file.type === '' ? 'application/octet-stream' : file.type },
      });
      if (!response.ok) throw new Error(`The upload failed (${response.status})`);

      setBusy('Reading the columns…');
      const local = await readColumns(file, fileType);
      // BACKEND PENDING: GET /imports/:id has no `rowCount`, `columns` or
      // pre-flight estimate fields, so D6b and D6c fall back to the local
      // parse below.
      const job: ImportJobView = await audienceApi.getImport(created.id);

      onReady({
        job: { ...job, encoding: job.encoding ?? 'UTF-8' },
        columns: job.columns ?? local,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  };

  const take = (file: File | undefined): void => {
    if (file !== undefined) void handle(file);
  };

  return (
    <Card className="p-6">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (allowed) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (allowed) take(event.dataTransfer.files[0]);
        }}
        className={[
          'flex flex-col items-center gap-2.5 rounded-card border-2 border-dashed px-6 py-12 text-center',
          dragging ? 'border-brand bg-brand-soft' : 'border-border bg-tint',
        ].join(' ')}
      >
        <span className="grid h-12 w-12 place-items-center rounded-card border border-border bg-surface text-brand">
          <Icon name="imports" size={22} />
        </span>
        <div className="text-card leading-heading font-semibold">Drop a CSV or XLSX here</div>
        <div className="text-ui text-text-2">
          Up to 50 MB or 500,000 rows. First row must be headers. UTF-8 recommended.
        </div>
        <Button
          variant="secondary"
          className="mt-1.5"
          disabled={!allowed || busy !== null}
          title={blockedTitle}
          onClick={() => input.current?.click()}
        >
          {busy ?? 'Choose file'}
        </Button>
        <input
          ref={input}
          type="file"
          accept=".csv,.tsv,.xlsx"
          aria-label="Choose a file to import"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so choosing the same file twice fires a change event.
            event.target.value = '';
            take(file);
          }}
        />
      </div>

      {error === null ? null : (
        <p role="alert" className="mt-3 mb-0 text-ui text-danger-text">
          {error}
        </p>
      )}

      <div className="mt-5 grid gap-4 text-ui sm:grid-cols-3">
        {UPLOAD_NOTES.map(([title, detail], index) => (
          <div key={title} className="flex gap-2.5">
            <span className="grid h-6 w-6 flex-none place-items-center rounded-badge bg-brand-soft text-caption font-semibold text-brand">
              {index + 1}
            </span>
            <span>
              <span className="block font-medium">{title}</span>
              <span className="block text-caption text-text-2">{detail}</span>
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function fileTypeOf(filename: string): 'csv' | 'tsv' | 'xlsx' | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.tsv')) return 'tsv';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  return null;
}

/**
 * Reads the header row and two sample values per column.
 *
 * Delimited files are parsed here with the same parser the importer uses,
 * so the columns shown are exactly the columns it will find — same BOM
 * handling, same quoting rules. An xlsx cannot be: it is a zip, and the
 * reader that opens one needs a seekable file and Node's zlib. Rather than
 * write a second spreadsheet reader for the browser, those wait for the
 * server's own analysis. Recorded in docs/16.
 */
export async function readColumns(
  file: File,
  fileType: 'csv' | 'tsv' | 'xlsx',
): Promise<ImportColumnAnalysis[]> {
  if (fileType === 'xlsx') return [];

  const slice = file.slice(0, 64 * 1024);
  const bytes = new Uint8Array(await slice.arrayBuffer());

  async function* once(): AsyncGenerator<Uint8Array> {
    yield bytes;
  }

  let headers: string[] | null = null;
  const samples: string[][] = [];

  for await (const row of parseDelimited(once(), { delimiter: fileType === 'tsv' ? '\t' : ',' })) {
    if (headers === null) {
      headers = row.cells;
      continue;
    }
    samples.push(row.cells);
    if (samples.length === 2) break;
  }

  if (headers === null) return [];

  return headers.map((name, index) => ({
    name,
    samples: samples.map((cells) => cells[index] ?? '').filter((value) => value !== ''),
  }));
}

/* ------------------------------------------------------------------ */
/* Stage 2 — D6b                                                       */
/* ------------------------------------------------------------------ */

/**
 * The targets a column can be mapped onto.
 *
 * A target is the string the importer reads: `email`, `firstName` and
 * `lastName` set the contact's own columns and anything else becomes an
 * attribute under that name (`packages/audience/src/import/pipeline.ts`,
 * `normaliseRow`). So Country is the target `country`, not a prefixed one —
 * a prefix would create an attribute with the prefix in its name.
 *
 * BACKEND PENDING: POST /imports/:id/mapping accepts no target for
 * "Created at (keep original)". It lands in attributes as `created_at`
 * today; the importer does not backdate the contact.
 */
const TARGETS: readonly (readonly [string, string])[] = [
  ['email', 'Email'],
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['country', 'Country'],
  ['language', 'Language'],
  ['created_at', 'Created at (keep original)'],
];

/** Explicitly skipped, as against not yet decided (no entry at all). */
const SKIP = '__skip__';

/** The options one column's select offers, including whatever it is set to. */
function targetsFor(columnName: string, current: string | undefined): (readonly [string, string])[] {
  const options = [...TARGETS];
  const add = (value: string): void => {
    if (!options.some(([candidate]) => candidate === value)) {
      options.push([value, `Custom attribute: ${value}`]);
    }
  };

  add(normaliseHeader(columnName));
  if (current !== undefined && current !== SKIP) add(current);

  return options;
}

/** The 14px arrow between a column and its target. `@relayd/ui` has no arrow icon. */
function MapsToArrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </svg>
  );
}

function MapColumnsStage({
  draft,
  onBack,
  onContinue,
}: {
  draft: Draft;
  onBack: () => void;
  onContinue: (mapping: Record<string, string>) => void;
}) {
  const names = useMemo(() => draft.columns.map((column) => column.name), [draft.columns]);
  const job = draft.job;

  /**
   * What the server detected, or — when it has not analysed the file — what
   * the browser can tell from the header names alone.
   */
  const guessed = useMemo(
    () => job.columnMapping ?? guessMapping(names),
    [job.columnMapping, names],
  );
  const [mapping, setMapping] = useState<Record<string, string>>(() => ({
    ...guessed,
    ...Object.fromEntries((job.skippedColumns ?? []).map((column) => [column, SKIP])),
  }));

  const decided = Object.entries(mapping).filter(([, target]) => target !== SKIP);
  const mappedCount = decided.length;
  const emailMapped = decided.some(([, target]) => target === 'email');

  const set = (column: string, target: string): void => {
    setMapping((current) => ({ ...current, [column]: target }));
  };

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="m-0 text-title leading-heading font-semibold tracking-heading">Import contacts</h1>
          <p className="mt-1 mb-0 text-body text-text-2">
            <span className="font-mono text-caption">{job.originalFilename}</span>
            {' · '}
            {joinFacts([
              job.byteSize === undefined ? null : megabytes(job.byteSize),
              job.rowCount === undefined ? null : `${count(job.rowCount)} rows`,
              `${draft.columns.length} columns`,
              job.encoding ?? null,
            ])}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Button variant="secondary" onClick={onBack}>
            Back
          </Button>
          <Button
            disabled={!emailMapped}
            title={emailMapped ? undefined : 'Map a column to Email to continue'}
            onClick={() => onContinue(Object.fromEntries(decided))}
          >
            Continue to consent
          </Button>
        </div>
      </div>

      <ImportStages current={1} />

      <Card flush>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4.5 py-3 text-ui">
          <span>
            {mappedCount} of {draft.columns.length} columns mapped automatically ·{' '}
            {emailMapped ? (
              <span className="font-medium text-success-text">email found</span>
            ) : (
              <span className="font-medium text-warning-text">email not found</span>
            )}
          </span>
          <span className="text-caption text-text-2">
            Unmapped columns are skipped. Create custom attributes for anything else.
          </span>
        </div>

        <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_36px_minmax(0,1.2fr)_120px] items-center border-b border-border bg-tint text-caption font-medium text-text-2 sm:grid">
          <div className="px-4.5 py-2">Column in file</div>
          <div className="px-3 py-2">Sample values</div>
          <div />
          <div className="px-3 py-2">Maps to</div>
          <div className="py-2 pr-4.5 pl-3" />
        </div>

        {draft.columns.map((column) => {
          const target = mapping[column.name];
          const auto = guessed[column.name] !== undefined && target === guessed[column.name];
          const skipped = target === SKIP;
          // Three states, not two: a column nobody has decided about is
          // prompted for in amber, a column somebody skipped is greyed. The
          // difference is what makes "Unmapped columns are skipped" a
          // statement about what will happen rather than a surprise.
          const undecided = target === undefined;

          return (
            <div
              key={column.name}
              className={[
                'grid min-h-[52px] grid-cols-1 items-center border-b border-border text-ui last:border-b-0',
                'sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_36px_minmax(0,1.2fr)_120px]',
                skipped ? 'opacity-55' : '',
              ].join(' ')}
            >
              <div className="flex min-w-0 items-center gap-2 px-4.5 pt-2.5 sm:py-2.5">
                <span className="truncate font-mono text-caption">{column.name}</span>
                {auto ? (
                  <span className="inline-flex h-4.5 flex-none items-center rounded-badge bg-success-soft px-1.5 text-pill font-semibold tracking-pill text-success-text uppercase">
                    auto
                  </span>
                ) : null}
              </div>

              <div className="truncate px-4.5 text-caption text-text-2 sm:px-3 sm:py-2.5">
                {column.samples.length === 0 ? '—' : column.samples.join(' · ')}
              </div>

              <div className="hidden place-items-center text-text-3 sm:grid" aria-hidden="true">
                <MapsToArrow />
              </div>

              <div className="flex items-center gap-2 px-4.5 py-2.5 sm:px-3">
                <select
                  aria-label={`Map ${column.name} to`}
                  value={target ?? ''}
                  onChange={(event) => set(column.name, event.target.value)}
                  className={[
                    'h-[34px] w-full min-w-0 cursor-pointer rounded-control border px-3 text-ui outline-none',
                    undecided ? 'border-warning bg-surface text-text-2' : '',
                    skipped ? 'border-border bg-tint text-text-2' : '',
                    undecided || skipped ? '' : 'border-border bg-surface text-text',
                  ].join(' ')}
                >
                  {undecided ? <option value="">Choose a field…</option> : null}
                  <option value={SKIP}>Skip column</option>
                  {targetsFor(column.name, target).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                {target === 'email' ? (
                  <span className="flex-none text-pill font-semibold tracking-pill text-brand uppercase">required</span>
                ) : null}
              </div>

              <div className="px-4.5 pb-2.5 text-right sm:px-3 sm:py-2.5">
                {target === 'email' ? null : skipped ? (
                  <button
                    type="button"
                    onClick={() => set(column.name, normaliseHeader(column.name))}
                    className="h-7 cursor-pointer rounded-badge border border-border bg-surface px-2 text-caption font-medium text-brand"
                  >
                    Include
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => set(column.name, SKIP)}
                    className="h-7 cursor-pointer rounded-badge border border-border bg-surface px-2 text-caption font-medium text-text-2"
                  >
                    Skip column
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {job.invalidEmailCount === undefined && job.existingEmailCount === undefined ? null : (
          <div className="flex items-start gap-2 px-4.5 py-3 text-caption text-text-2">
            <Icon name="alert" size={14} strokeWidth={2} className="mt-0.5 flex-none text-warning-text" />
            <span>
              {job.invalidEmailCount === undefined
                ? ''
                : `${count(job.invalidEmailCount)} rows have an invalid email format and will be reported as failed. `}
              {job.existingEmailCount === undefined
                ? ''
                : `${count(job.existingEmailCount)} emails already exist and will be updated, not duplicated.`}
            </span>
          </div>
        )}
      </Card>
    </>
  );
}

/**
 * A preselection, not a decision.
 *
 * Only exact matches on the normalised header are offered, so "emailed_at"
 * does not become the email address. Guessing from a header name and
 * applying it silently is how a "phone" column ends up in the last name
 * field; the guess is offered as something the user can see and change,
 * which is a different thing.
 */
export function guessMapping(headers: readonly string[]): Record<string, string> {
  const known: Record<string, string> = {
    email: 'email',
    email_address: 'email',
    emailaddress: 'email',
    first_name: 'firstName',
    firstname: 'firstName',
    given_name: 'firstName',
    last_name: 'lastName',
    lastname: 'lastName',
    surname: 'lastName',
    family_name: 'lastName',
  };

  const mapping: Record<string, string> = {};
  const used = new Set<string>();

  for (const header of headers) {
    const field = known[normaliseHeader(header)];
    // First column wins: a file with two "email" columns must not silently
    // import the second one.
    if (field !== undefined && !used.has(field)) {
      mapping[header] = field;
      used.add(field);
    }
  }

  return mapping;
}

/* ------------------------------------------------------------------ */
/* Stage 3 — D6c                                                       */
/* ------------------------------------------------------------------ */

const ATTESTATION = 'I confirm these contacts gave consent to receive email from this sender';

function ConsentStage({
  draft,
  mapping,
  onBack,
  onStarted,
}: {
  draft: Draft;
  mapping: Record<string, string>;
  onBack: () => void;
  onStarted: () => void;
}) {
  const navigate = useNavigate();
  const readOnly = useReadOnly();
  const zone = useZone();
  const { user } = useAuth();
  const job = draft.job;

  const lists = useQuery({ queryKey: audienceKeys.lists, queryFn: audienceApi.listLists });
  const tags = useQuery({ queryKey: audienceKeys.tags, queryFn: audienceApi.listTags });

  const [confirmed, setConfirmed] = useState(false);
  const [source, setSource] = useState<ConsentSource | ''>('');
  const [listId, setListId] = useState('');
  const [updateExisting, setUpdateExisting] = useState(true);
  const [tagging, setTagging] = useState(false);
  const [tagName, setTagName] = useState(defaultImportTag());

  const mappedCount = Object.keys(mapping).length;
  const skippedCount = draft.columns.length - mappedCount;

  const start = useMutation({
    mutationFn: async () => {
      const tagIds: string[] = [];
      if (tagging && tagName.trim() !== '') {
        const existing = (tags.data ?? []).find((tag) => tag.name === tagName.trim());
        const tag = existing ?? (await audienceApi.createTag({ name: tagName.trim() }));
        tagIds.push(tag.id);
      }

      return audienceApi.setImportMapping(job.id, {
        mapping,
        options: {
          updateExisting,
          addToListIds: listId === '' ? [] : [listId],
          tagIds,
          // The sentence they ticked, recorded verbatim. docs/02 wants the
          // sender's own words on every contact; this screen's words are a
          // statement they made, so they are the words that go on the row.
          consentDeclaration: `${ATTESTATION} — ${sourceLabel(source)}`,
          consentSource: source as ConsentSource,
        },
      });
    },
    onSuccess: () => {
      onStarted();
      void navigate(`/audience/imports/${job.id}`);
    },
  });

  const ready = confirmed && source !== '' && !readOnly;
  const startTitle = readOnly
    ? 'Workspace is read-only'
    : !confirmed
      ? 'Confirm consent to continue'
      : source === ''
        ? 'Choose where these contacts gave consent'
        : undefined;

  const attestedLine = joinFacts([
    `Recorded as: ${user?.name ?? user?.email ?? 'you'}`,
    day(new Date(), zone),
    job.originalFilename,
    job.rowCount === undefined ? null : `${count(job.rowCount)} rows`,
  ]);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="m-0 text-title leading-heading font-semibold tracking-heading">Import contacts</h1>
          <p className="mt-1 mb-0 text-body text-text-2">
            <span className="font-mono text-caption">{job.originalFilename}</span>
            {' · '}
            {joinFacts([
              job.rowCount === undefined ? null : `${count(job.rowCount)} rows`,
              `${mappedCount} columns mapped`,
              `${skippedCount} skipped`,
            ])}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Button variant="secondary" onClick={onBack}>
            Back
          </Button>
          <IfPermitted permission="contact:import">
            <Button
              disabled={!ready || start.isPending}
              title={startTitle}
              pending={start.isPending}
              onClick={() => start.mutate()}
            >
              Start import
            </Button>
          </IfPermitted>
        </div>
      </div>

      <ImportStages current={2} />

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="flex flex-col gap-5 p-6">
          <div>
            <h2 className="m-0 text-section leading-heading font-semibold">Consent attestation</h2>
            <p className="mt-1.5 mb-0 text-ui text-pretty text-text-2">
              Relayd sends through your own provider, so your sender reputation is on the line. Only import people
              who have agreed to hear from this sender. Purchased or scraped lists are not allowed.
            </p>
          </div>

          <div className="rounded-control border border-border bg-surface px-4 py-3.5">
            <Checkbox
              label={ATTESTATION}
              description={attestedLine}
              checked={confirmed}
              disabled={readOnly}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
          </div>

          <div className="grid gap-4 text-ui sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="font-medium">
                Consent source <span className="font-normal text-text-2">· stored on each contact</span>
              </span>
              {/*
                No default selection. A pre-selected source would be attested
                by everyone who clicked past this screen without reading it,
                which is the opposite of what an attestation is for.
              */}
              <select
                value={source}
                disabled={readOnly}
                onChange={(event) => setSource(event.target.value as ConsentSource)}
                className="h-9 w-full cursor-pointer rounded-control border border-border bg-surface px-3 text-ui outline-none"
              >
                <option value="">Choose one…</option>
                {CONSENT_SOURCE_LABELS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="font-medium">
                Add to list <span className="font-normal text-text-2">· optional</span>
              </span>
              <select
                value={listId}
                disabled={readOnly}
                onChange={(event) => setListId(event.target.value)}
                className="h-9 w-full cursor-pointer rounded-control border border-border bg-surface px-3 text-ui outline-none"
              >
                <option value="">No list</option>
                {(lists.data ?? []).map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-col gap-2 text-ui">
            <Checkbox
              label={
                <>
                  Update existing contacts with values from this file{' '}
                  {job.existingEmailCount === undefined ? null : (
                    <span className="text-text-2">({count(job.existingEmailCount)} matches)</span>
                  )}
                </>
              }
              checked={updateExisting}
              disabled={readOnly}
              onChange={(event) => setUpdateExisting(event.target.checked)}
            />
            <Checkbox
              label={
                <>
                  Tag everyone in this import <span className="text-text-2">· e.g. {defaultImportTag()}</span>
                </>
              }
              checked={tagging}
              disabled={readOnly}
              onChange={(event) => setTagging(event.target.checked)}
            />
            {tagging ? (
              <input
                aria-label="Tag name"
                value={tagName}
                onChange={(event) => setTagName(event.target.value)}
                className="h-9 w-full max-w-xs rounded-control border border-border bg-surface px-3 text-ui outline-none"
              />
            ) : null}
          </div>

          {start.isError ? (
            <div role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-caption text-danger-text">
              {start.error instanceof Error ? start.error.message : 'The import did not start.'}
            </div>
          ) : null}
        </Card>

        <Card className="flex flex-col gap-3 px-5 py-4.5 text-ui">
          <div className="font-semibold">What will happen</div>
          <SummaryRow label="Rows in file" value={job.rowCount === undefined ? '—' : count(job.rowCount)} />
          <SummaryRow
            label="New contacts"
            strong
            value={
              job.rowCount === undefined || job.existingEmailCount === undefined || job.invalidEmailCount === undefined
                ? '—'
                : `≈ ${count(Math.max(0, job.rowCount - job.existingEmailCount - job.invalidEmailCount))}`
            }
          />
          <SummaryRow
            label="Updated"
            value={job.existingEmailCount === undefined ? '—' : `≈ ${count(job.existingEmailCount)}`}
          />
          <SummaryRow
            label="Invalid email · reported"
            danger
            value={job.invalidEmailCount === undefined ? '—' : count(job.invalidEmailCount)}
          />
          <SummaryRow
            label="Already suppressed · stay suppressed"
            divider
            value={job.suppressedCount === undefined ? '—' : count(job.suppressedCount)}
          />
          <SummaryRow
            label="Contacts after import"
            value={
              job.contactsAfter === undefined
                ? '—'
                : `≈ ${count(job.contactsAfter)}${job.contactLimit === undefined ? '' : ` / ${count(job.contactLimit)}`}`
            }
          />
          <div className="border-t border-border pt-2 text-caption text-text-2">
            Nothing has been saved yet. Closing this page discards the upload.
          </div>
        </Card>
      </div>
    </>
  );
}

function SummaryRow({
  label,
  value,
  strong = false,
  danger = false,
  divider = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  danger?: boolean;
  divider?: boolean;
}) {
  return (
    <div className={`flex justify-between gap-3 ${divider ? 'border-t border-border pt-2.5' : ''}`}>
      <span className="text-text-2">{label}</span>
      <span
        className={[
          'tabular-nums whitespace-nowrap',
          strong ? 'font-medium' : '',
          danger ? 'text-danger-text' : '',
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  );
}

function sourceLabel(source: string): string {
  return CONSENT_SOURCE_LABELS.find(([value]) => value === source)?.[1] ?? 'unspecified';
}

function defaultImportTag(): string {
  const now = new Date();
  return `import-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Stage 4 — D6d, /audience/imports/:id                                */
/* ------------------------------------------------------------------ */

export function ImportRunPage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const readOnly = useReadOnly();
  const zone = useZone();
  const id = params['id'] ?? '';

  const job = useQuery<ImportJobView>({
    queryKey: audienceKeys.import(id),
    queryFn: () => audienceApi.getImport(id),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined) return false;
      return ACTIVE.includes(data.status) ? 1500 : false;
    },
  });

  const history = useQuery<ImportJobView[]>({
    queryKey: audienceKeys.imports,
    queryFn: audienceApi.listImports,
  });

  const cancel = useMutation({
    mutationFn: () => audienceApi.cancelImport(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: audienceKeys.import(id) });
      void queryClient.invalidateQueries({ queryKey: audienceKeys.imports });
    },
  });

  if (job.isPending) {
    return <TableSkeleton rows={4} tabs={false} label="Loading import" />;
  }

  if (job.isError) {
    return (
      <ErrorState
        title="We couldn't load this import"
        description="Running imports continue in the background. Send support the request ID if it keeps happening."
        requestId={job.error instanceof ApiError ? job.error.requestId : undefined}
        onRetry={() => void job.refetch()}
        retryLabel="Retry"
      />
    );
  }

  const row = job.data;
  const running = ACTIVE.includes(row.status);
  const total = row.totalRows ?? row.rowCount ?? null;
  const look = statusLook(row);

  const share = (value: number): number =>
    total === null || total === 0 ? 0 : Math.min(100, (value / total) * 100);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="m-0 text-title leading-heading font-semibold tracking-heading">Import contacts</h1>
          <p className="mt-1 mb-0 text-body text-text-2">
            <span className="font-mono text-caption">{row.originalFilename}</span>
            {' · '}
            <span className="font-mono text-caption">{row.id}</span>
            {row.attestedBy === undefined ? null : ` · consent attested by ${row.attestedBy}, ${stamp(row.createdAt, zone)}`}
          </p>
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2">
          {running ? (
            <IfPermitted permission="contact:import">
              <Button
                variant="secondary"
                disabled={readOnly || cancel.isPending}
                title={readOnly ? 'Workspace is read-only' : undefined}
                pending={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel import
              </Button>
            </IfPermitted>
          ) : (
            <>
              {row.failedCount > 0 ? <FailedRowsDownload job={row} /> : null}
              <Link
                to="/audience/contacts"
                className="inline-flex h-[34px] items-center rounded-control bg-brand px-3 text-ui font-medium text-on-brand no-underline hover:bg-brand-hover hover:text-on-brand"
              >
                View contacts
              </Link>
            </>
          )}
        </div>
      </div>

      <ImportStages current={3} />

      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <StatusBadge job={row} />
            <span className="text-ui text-text-2">
              {running
                ? joinFacts([
                    // BACKEND PENDING: GET /imports/:id has no `etaSeconds`
                    // field, so the line degrades to the promise.
                    row.etaSeconds === undefined ? null : `about ${count(row.etaSeconds)} seconds left`,
                    'you can leave this page',
                  ])
                : row.completedAt === null
                  ? look.label
                  : `finished ${stamp(row.completedAt, zone)}${row.failedCount > 0 ? ` · ${count(row.failedCount)} rows need attention` : ''}`}
            </span>
          </div>
          <span className="text-ui tabular-nums">
            <span className="font-semibold">{count(row.processedRows)}</span>{' '}
            <span className="text-text-2">{total === null ? 'rows so far' : `of ${count(total)} rows`}</span>
          </span>
        </div>

        <div
          role="progressbar"
          aria-label={`${row.originalFilename} import progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={total === null ? undefined : Math.round(share(row.processedRows))}
          className="mt-3.5 flex h-2.5 overflow-hidden rounded-5 bg-neutral-soft"
        >
          <div className="bg-success" style={{ width: `${share(row.createdCount)}%` }} />
          <div className="bg-info" style={{ width: `${share(row.updatedCount)}%` }} />
          <div className="bg-seg-pending" style={{ width: `${share(row.skippedCount)}%` }} />
          <div className="bg-danger" style={{ width: `${share(row.failedCount)}%` }} />
        </div>

        <div className="mt-4.5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Tile swatch="bg-success" label="Created" value={count(row.createdCount)} />
          <Tile swatch="bg-info" label="Updated" value={count(row.updatedCount)} />
          <Tile swatch="bg-seg-pending" label="Skipped duplicates" value={count(row.skippedCount)} />
          <Tile swatch="bg-danger" label="Failed" value={count(row.failedCount)} danger />
        </div>

        {!running && row.failedCount > 0 ? <FailedRowsReport job={row} /> : null}
      </Card>

      {history.data === undefined || history.data.length === 0 ? null : <ImportHistory jobs={history.data} />}
    </>
  );
}

function Tile({
  swatch,
  label,
  value,
  danger = false,
}: {
  swatch: string;
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-control border border-border px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-caption text-text-2">
        <span className={`h-2.5 w-2.5 rounded-2 ${swatch}`} aria-hidden="true" />
        {label}
      </div>
      <div
        className={`mt-1 text-title leading-heading font-semibold tracking-heading tabular-nums ${danger ? 'text-danger-text' : ''}`}
      >
        {value}
      </div>
    </div>
  );
}

const ERROR_LABEL: Record<string, string> = {
  invalid_email: 'Invalid email',
  email_invalid: 'Invalid email',
  duplicate: 'Duplicate',
  missing_email: 'Invalid email',
};

function FailedRowsReport({ job }: { job: ImportJobView }) {
  const errors = useQuery({
    queryKey: audienceKeys.importErrors(job.id),
    queryFn: () => audienceApi.listImportErrors(job.id),
  });

  const rows = errors.data ?? [];

  return (
    <div className="mt-5 border-t border-border pt-4.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-semibold">Failed rows · {count(job.failedCount)}</div>
        <span className="text-caption text-text-2">
          Fix these in your file and import again; existing contacts will be updated, not duplicated.
        </span>
      </div>

      <div className="mt-2.5 overflow-hidden rounded-control border border-border">
        <div className="hidden grid-cols-[80px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.6fr)] items-center border-b border-border bg-tint text-caption font-medium text-text-2 sm:grid">
          <div className="px-3 py-2">Row</div>
          <div className="px-3 py-2">Email</div>
          <div className="px-3 py-2">Reason</div>
          <div className="px-3 py-2">Detail</div>
        </div>

        {rows.map((error) => (
          <div
            key={`${error.rowNumber}-${error.errorCode}`}
            className="grid min-h-10 grid-cols-1 items-center border-b border-border text-ui sm:grid-cols-[80px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.6fr)]"
          >
            <div className="px-3 pt-1.5 font-mono text-caption text-text-2 sm:py-1.5">{count(error.rowNumber)}</div>
            <div className="truncate px-3 font-mono text-caption sm:py-1.5">
              {error.rawValue === undefined || error.rawValue === '' ? '(empty)' : error.rawValue}
            </div>
            <div className="px-3 py-1.5">
              <Badge tone="danger">{ERROR_LABEL[error.errorCode] ?? 'Rejected'}</Badge>
            </div>
            <div className="px-3 pb-1.5 text-caption text-text-2 sm:py-1.5">{error.message}</div>
          </div>
        ))}

        <div className="px-3 py-2 text-caption text-text-2">
          Showing {count(rows.length)} of {count(job.failedCount)} · the download includes every failed row with its
          original columns.
        </div>
      </div>
    </div>
  );
}

/**
 * Downloads the rejected rows as a CSV.
 *
 * Built with the same `toCsvLines` the export path uses, so every cell is
 * neutralised against formula injection. That matters more here than
 * anywhere else in the product: this file is made of values the importer
 * rejected — the most attacker-influenced data we hold — and it is
 * downloaded and opened in Excel by definition.
 */
function FailedRowsDownload({ job }: { job: ImportJobView }) {
  const [building, setBuilding] = useState(false);

  const download = async (): Promise<void> => {
    setBuilding(true);
    try {
      const errors = await audienceApi.listImportErrors(job.id);

      const columns = [
        { header: 'Row', value: (error: ImportRowError) => error.rowNumber },
        { header: 'Column', value: (error: ImportRowError) => error.columnName ?? '' },
        { header: 'Problem', value: (error: ImportRowError) => error.message },
        { header: 'Code', value: (error: ImportRowError) => error.errorCode },
        { header: 'Value', value: (error: ImportRowError) => error.rawValue ?? '' },
      ];

      const parts: string[] = [];
      for await (const line of toCsvLines(columns, errors)) parts.push(line);

      const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${job.originalFilename}-failed-rows.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setBuilding(false);
    }
  };

  return (
    <Button variant="secondary" disabled={building} onClick={() => void download()}>
      <Icon name="imports" size={14} strokeWidth={2} className="rotate-180" />
      {building ? 'Preparing…' : `Download failed rows (${count(job.failedCount)})`}
    </Button>
  );
}
