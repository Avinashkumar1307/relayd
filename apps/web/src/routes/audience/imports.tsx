import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { normaliseHeader, parseDelimited, toCsvLines } from '@relayd/audience/browser';
import {
  CONTACT_FIELDS,
  audienceApi,
  audienceKeys,
  type ImportJob,
  type ImportRowError,
  type ImportStatus,
} from '../../api/audience.js';
import { IfPermitted } from '../../auth/guards.js';
import { CONSENT_SOURCE_LABELS, type ConsentSource } from '../../components/consent.js';
import { Badge, Button, Cell, EmptyState, LoadError, Loading, Page, Table, formatDate } from '../../components/ui.js';

/**
 * Imports.
 *
 * Three things happen here: a file is uploaded straight to object storage, its
 * columns are mapped onto contact fields, and the job's progress is followed
 * until it finishes. The file never passes through our API — a presigned PUT
 * costs us nothing and the alternative holds a 100 MB upload in memory twice.
 */

const ACTIVE: readonly ImportStatus[] = ['pending', 'mapping', 'validating', 'processing'];

const STATUS_TONE: Record<ImportStatus, 'neutral' | 'good' | 'warn' | 'bad'> = {
  pending: 'neutral',
  mapping: 'neutral',
  validating: 'neutral',
  processing: 'warn',
  completed: 'good',
  failed: 'bad',
  cancelled: 'neutral',
};

export function ImportsPage() {
  const queryClient = useQueryClient();
  const [mappingJob, setMappingJob] = useState<{ job: ImportJob; headers: string[] } | null>(null);

  const imports = useQuery({
    queryKey: audienceKeys.imports,
    queryFn: audienceApi.listImports,
    /**
     * Poll only while something is moving.
     *
     * A dashboard left open on a finished page should not keep asking. The
     * interval stops on its own when every job has settled, which is what
     * makes this safe to leave running.
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

  const cancel = useMutation({
    mutationFn: (id: string) => audienceApi.cancelImport(id),
    onSuccess: invalidate,
  });

  return (
    <Page
      title="Imports"
      description="Upload a CSV, TSV or Excel file and map its columns onto contact fields."
      action={
        <IfPermitted permission="contact:import">
          <UploadButton onReady={(job, headers) => setMappingJob({ job, headers })} />
        </IfPermitted>
      }
    >
      {mappingJob !== null && (
        <MappingStep
          job={mappingJob.job}
          headers={mappingJob.headers}
          onDone={() => {
            setMappingJob(null);
            invalidate();
          }}
          onCancel={() => setMappingJob(null)}
        />
      )}

      {imports.isPending ? (
        <Loading />
      ) : imports.isError ? (
        <LoadError error={imports.error} onRetry={() => void imports.refetch()} />
      ) : imports.data.length === 0 ? (
        <EmptyState title="No imports yet">
          A file of up to 100 MB can be imported in one go.
        </EmptyState>
      ) : (
        <Table
          columns={['File', 'Status', 'Progress', 'Result', 'Started', '']}
          caption="Imports"
        >
          {imports.data.map((job) => (
            <ImportRow key={job.id} job={job} onCancel={() => cancel.mutate(job.id)} />
          ))}
        </Table>
      )}
    </Page>
  );
}

function ImportRow({ job, onCancel }: { job: ImportJob; onCancel: () => void }) {
  const active = ACTIVE.includes(job.status);

  return (
    <tr>
      <Cell>{job.originalFilename}</Cell>
      <Cell>
        <Badge tone={STATUS_TONE[job.status]}>{job.status}</Badge>
      </Cell>
      <Cell>
        <Progress job={job} />
      </Cell>
      <Cell muted>
        {job.status === 'completed' || job.failedCount > 0 ? (
          <span>
            {job.createdCount.toLocaleString()} new, {job.updatedCount.toLocaleString()} updated,{' '}
            {job.skippedCount.toLocaleString()} skipped, {job.failedCount.toLocaleString()} failed
          </span>
        ) : (
          '—'
        )}
      </Cell>
      <Cell muted>{formatDate(job.createdAt)}</Cell>
      <Cell>
        <div className="flex justify-end gap-2">
          {job.failedCount > 0 && <FailedRowsDownload job={job} />}
          {active && (
            <IfPermitted permission="contact:import">
              <Button variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            </IfPermitted>
          )}
        </div>
      </Cell>
    </tr>
  );
}

/**
 * Progress against a total that may not be known yet.
 *
 * `totalRows` is null until the file has been counted, so an indeterminate
 * state is a real state rather than an edge case — showing 0% for a job that
 * is working reads as broken.
 */
function Progress({ job }: { job: ImportJob }) {
  if (!ACTIVE.includes(job.status)) {
    return <span className="text-slate-500">{job.processedRows.toLocaleString()} rows</span>;
  }

  if (job.totalRows === null) {
    return <span className="text-slate-500">{job.processedRows.toLocaleString()} rows so far…</span>;
  }

  const percent = Math.min(100, Math.round((job.processedRows / Math.max(job.totalRows, 1)) * 100));

  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${job.originalFilename} import progress`}
        className="h-2 w-24 overflow-hidden rounded-full bg-slate-200"
      >
        <div className="h-full bg-slate-900" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-xs text-slate-600">{percent}%</span>
    </div>
  );
}

/**
 * Downloads the rejected rows as a CSV.
 *
 * Built with the same `toCsvLines` the export path uses, so every cell is
 * neutralised against formula injection. That matters more here than anywhere
 * else in the product: this file is made of values the importer rejected —
 * the most attacker-influenced data we hold — and it is downloaded and opened
 * in Excel by definition.
 */
function FailedRowsDownload({ job }: { job: ImportJob }) {
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
      {building ? 'Preparing…' : 'Failed rows'}
    </Button>
  );
}

/**
 * Picks a file, creates the job, uploads, and reads the header row.
 *
 * Headers are read in the browser for delimited files, from the first 64 KB —
 * enough for any real header row and small enough that a 100 MB file is not
 * re-read to show a form.
 */
function UploadButton({ onReady }: { onReady: (job: ImportJob, headers: string[]) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      const headers = await readHeaders(file, fileType);
      const job = await audienceApi.getImport(created.id);

      onReady(job, headers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-1">
      <label
        htmlFor="import-file"
        className="inline-block cursor-pointer rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
      >
        {busy ?? 'Import a file'}
      </label>
      <input
        id="import-file"
        type="file"
        accept=".csv,.tsv,.xlsx"
        disabled={busy !== null}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file twice fires a change event.
          event.target.value = '';
          if (file !== undefined) void handle(file);
        }}
      />
      {error !== null && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
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
 * Reads the header row.
 *
 * Delimited files are parsed here with the same parser the importer uses, so
 * the columns shown are exactly the columns it will find — including its BOM
 * handling and its quoting rules.
 *
 * An xlsx cannot be: it is a zip, and the reader that opens one needs a
 * seekable file and Node's zlib. Rather than write a second spreadsheet
 * reader for the browser, the mapping form lets the headers be typed for
 * those. Recorded in docs/16.
 */
async function readHeaders(file: File, fileType: 'csv' | 'tsv' | 'xlsx'): Promise<string[]> {
  if (fileType === 'xlsx') return [];

  const slice = file.slice(0, 64 * 1024);
  const bytes = new Uint8Array(await slice.arrayBuffer());

  async function* once(): AsyncGenerator<Uint8Array> {
    yield bytes;
  }

  for await (const row of parseDelimited(once(), { delimiter: fileType === 'tsv' ? '\t' : ',' })) {
    return row.cells;
  }

  return [];
}

/**
 * The column-mapping step.
 *
 * Every column defaults to "don't import". Guessing a mapping from a header
 * name and applying it silently is how a "phone" column ends up in the last
 * name field; the guess is offered as a preselection the user can see and
 * change, which is a different thing.
 */
function MappingStep({
  job,
  headers,
  onDone,
  onCancel,
}: {
  job: ImportJob;
  headers: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [columns, setColumns] = useState<string[]>(headers);
  const [mapping, setMapping] = useState<Record<string, string>>(() => guessMapping(headers));
  const [declaration, setDeclaration] = useState('');
  const [source, setSource] = useState<ConsentSource | ''>('');
  const [updateExisting, setUpdateExisting] = useState(true);

  const submit = useMutation({
    mutationFn: () =>
      audienceApi.setImportMapping(job.id, {
        mapping,
        options: {
          updateExisting,
          addToListIds: [],
          tagIds: [],
          consentDeclaration: declaration.trim(),
          consentSource: source as ConsentSource,
        },
      }),
    onSuccess: onDone,
  });

  const emailMapped = Object.values(mapping).includes('email');
  const declarationValid = declaration.trim().length >= 10;
  const sourceChosen = source !== '';

  return (
    <section className="space-y-4 rounded-lg border border-slate-300 bg-white p-5">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Map the columns</h2>
        <p className="text-sm text-slate-600">
          {job.originalFilename} — choose what each column in your file means.
        </p>
      </div>

      {columns.length === 0 ? (
        <TypedHeaders onSubmit={setColumns} />
      ) : (
        <>
          <Table columns={['Column in your file', 'Import as']} caption="Column mapping">
            {columns.map((column) => (
              <tr key={column}>
                <Cell>{column}</Cell>
                <Cell>
                  <label className="sr-only" htmlFor={`map-${column}`}>
                    Import {column} as
                  </label>
                  <select
                    id={`map-${column}`}
                    value={mapping[column] ?? ''}
                    onChange={(event) =>
                      setMapping((current) => {
                        const next = { ...current };
                        if (event.target.value === '') delete next[column];
                        else next[column] = event.target.value;
                        return next;
                      })
                    }
                    className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                  >
                    <option value="">Don&apos;t import</option>
                    {CONTACT_FIELDS.map((field) => (
                      <option key={field.value} value={field.value}>
                        {field.label}
                      </option>
                    ))}
                    <option value={`attr:${normaliseHeader(column)}`}>
                      Custom attribute ({normaliseHeader(column)})
                    </option>
                  </select>
                </Cell>
              </tr>
            ))}
          </Table>

          {!emailMapped && (
            <p role="alert" className="text-sm text-amber-700">
              One column must be mapped to the email address before this can start.
            </p>
          )}

          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              checked={updateExisting}
              onChange={(event) => setUpdateExisting(event.target.checked)}
            />
            Update contacts that already exist
          </label>

          <div className="space-y-1">
            <label htmlFor="consent-source" className="block text-sm font-medium text-slate-800">
              Where did these people give consent?
            </label>
            {/*
              A chosen value alongside the free text below, not instead of
              it. The vocabulary is what makes "how many workspaces claim to
              be importing from a previous provider" a GROUP BY; the free
              text is what a regulator actually reads.

              No default selection. A pre-selected "Signup form" would be
              attested by everyone who clicked past this screen without
              reading it, which is the opposite of what an attestation is
              for.
            */}
            <select
              id="consent-source"
              value={source}
              onChange={(event) => setSource(event.target.value as ConsentSource)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Choose one…</option>
              {CONSENT_SOURCE_LABELS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="consent-declaration" className="block text-sm font-medium text-slate-800">
              How did these people consent?
            </label>
            {/*
              Mandatory, and recorded on every contact this import creates.
              docs/02: it is what lets a workspace be defended when a provider
              or a regulator asks, and what lets one that lied be suspended.
            */}
            <textarea
              id="consent-declaration"
              value={declaration}
              onChange={(event) => setDeclaration(event.target.value)}
              rows={2}
              placeholder="Signed up at checkout between 2024 and 2026 with a ticked opt-in box"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <p className="text-xs text-slate-500">
              Recorded against every contact this import creates. At least 10 characters.
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              disabled={!emailMapped || !declarationValid || !sourceChosen || submit.isPending}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? 'Starting…' : 'Start import'}
            </Button>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          </div>

          {submit.isError && <LoadError error={submit.error} />}
        </>
      )}
    </section>
  );
}

/** For xlsx, where the browser cannot read the header row itself. */
function TypedHeaders({ onSubmit }: { onSubmit: (columns: string[]) => void }) {
  const [value, setValue] = useState('');

  return (
    <div className="space-y-2">
      <label htmlFor="typed-headers" className="block text-sm font-medium text-slate-800">
        Column headings
      </label>
      <p className="text-xs text-slate-500">
        Excel files are read by the importer rather than the browser, so type the headings from the
        first row of your sheet, separated by commas.
      </p>
      <input
        id="typed-headers"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="email, first name, country"
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
      />
      <Button
        disabled={value.trim() === ''}
        onClick={() =>
          onSubmit(
            value
              .split(',')
              .map((part) => part.trim())
              .filter((part) => part !== ''),
          )
        }
      >
        Continue
      </Button>
    </div>
  );
}

/**
 * A preselection, not a decision.
 *
 * Only exact matches on the normalised header are offered, so "emailed_at"
 * does not become the email address.
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
