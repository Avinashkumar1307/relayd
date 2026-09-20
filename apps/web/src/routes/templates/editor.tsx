import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  CAMPAIGN_STATES,
  DetailSkeleton,
  ErrorState,
  Field,
  Icon,
  Modal,
  Select,
  StateBadge,
  Tabs,
} from '@relayd/ui';
import {
  MERGE_TAGS,
  PREVIEW_PEOPLE,
  templateApi,
  templateKeys,
  type PreviewPerson,
  type Template,
  type TemplateVersion,
} from '../../api/templates.js';
import { providerApi, providerKeys } from '../../api/providers.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { useReadOnly } from '../../auth/workspace-state.js';
import {
  ClockIcon,
  CodeEditor,
  InlineSelect,
  LintBar,
  LockChip,
  MonitorIcon,
  PhoneIcon,
  RequiredChip,
  SegmentedToggle,
  lintHtml,
  requestId,
  sentence,
} from './parts.js';

/**
 * F2 — the template editor.
 *
 * Three panes: the source on the left (HTML, Plain text, Settings), the
 * rendered email in the middle, and the version history on the right when it
 * is asked for (F2b). F2c is the same screen in dark mode with the mobile
 * preview — nothing is special-cased for either; the tokens carry the theme
 * and the width is a toggle.
 *
 * Two rules from the design the code keeps:
 *
 *   A published version is immutable. The editor for one is read-only and
 *   says why; saving writes a new draft. A campaign that sent this template
 *   records the exact version, so editing one in place would rewrite history.
 *
 *   Merge tags are content. `{{first_name|"there"}}` is written into the
 *   source and shown literally everywhere in this app. Only the preview
 *   endpoint interpolates, and only on the server.
 */

const DEVICES = [
  { value: 'desktop' as const, label: 'Desktop', icon: <MonitorIcon /> },
  { value: 'mobile' as const, label: 'Mobile', icon: <PhoneIcon /> },
];

/** The mail client's chrome. Light in both themes — F2c draws it that way. */
const INBOX = { color: '#6B7280', borderBottom: '1px solid #E5E7EB' };
const INBOX_STRONG = { color: '#111827' };
const INBOX_MUTED = { color: '#9CA3AF' };

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'ar', label: 'Arabic' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
];

export function TemplateEditorPage() {
  const { id = '' } = useParams();
  const { currentWorkspaceId } = useAuth();

  const detail = useQuery({
    queryKey: templateKeys.detail(currentWorkspaceId, id),
    queryFn: () => templateApi.get(id),
    enabled: id !== '',
  });

  const back = (
    <Link to="/templates" className="text-ui font-medium text-brand no-underline hover:underline">
      &larr; Templates
    </Link>
  );

  if (detail.isPending) {
    return (
      <>
        <div className="mb-4">{back}</div>
        <DetailSkeleton label="Loading template" />
      </>
    );
  }

  if (detail.isError) {
    return (
      <>
        <div className="mb-4">{back}</div>
        <ErrorState
          title="We couldn't load this template"
          description={`${sentence(detail.error)} Published versions used by campaigns are unaffected. Send support the request ID if it keeps happening.`}
          {...requestId(detail.error)}
          onRetry={() => void detail.refetch()}
          retryLabel="Retry"
        />
      </>
    );
  }

  return <Editor key={id} templateId={id} template={detail.data.template} versions={detail.data.versions} />;
}

interface Draft {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  textEdited: boolean;
}

function Editor({
  templateId,
  template,
  versions,
}: {
  templateId: string;
  template: Template;
  versions: TemplateVersion[];
}) {
  const queryClient = useQueryClient();
  const { currentWorkspaceId, can, user } = useAuth();
  const readOnly = useReadOnly();
  const [params, setParams] = useSearchParams();

  const newest = versions[0];

  const [selectedId, setSelectedId] = useState(newest?.id ?? '');
  const [tab, setTab] = useState('html');
  const [showHistory, setShowHistory] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [personId, setPersonId] = useState(PREVIEW_PEOPLE[0]?.id ?? '');
  const [testTo, setTestTo] = useState(user?.email ?? '');

  const version = versions.find((entry) => entry.id === selectedId) ?? newest;
  const published = version !== undefined && version.publishedAt !== null;

  const [draft, setDraft] = useState<Draft>({
    subject: version?.subject ?? '',
    preheader: version?.preheader ?? '',
    html: version?.htmlSource ?? '',
    text: version?.textBody ?? '',
    textEdited: false,
  });

  const [settings, setSettings] = useState({
    defaultSenderId: template.defaultSenderId ?? '',
    language: template.language ?? 'en',
  });

  // Selecting another version replaces what is being edited. Losing an
  // unsaved draft silently would be worse, so the buttons that switch are
  // only offered on a version other than the one in the editor.
  const versionId = version?.id;
  useEffect(() => {
    const picked = versions.find((entry) => entry.id === versionId);
    if (picked === undefined) return;
    setDraft({
      subject: picked.subject,
      preheader: picked.preheader ?? '',
      html: picked.htmlSource,
      text: picked.textBody,
      textEdited: false,
    });
  }, [versionId, versions]);

  const htmlRef = useRef<HTMLTextAreaElement | null>(null);
  const testOpen = params.get('test') === '1';

  const senders = useQuery({
    queryKey: providerKeys.senders(currentWorkspaceId ?? ''),
    queryFn: () => providerApi.listSenders(),
  });

  const person: PreviewPerson | undefined =
    PREVIEW_PEOPLE.find((entry) => entry.id === personId) ?? PREVIEW_PEOPLE[0];

  const contact = {
    ...(person?.firstName === undefined ? {} : { firstName: person.firstName }),
    ...(person?.lastName === undefined ? {} : { lastName: person.lastName }),
    ...(person?.email === undefined ? {} : { email: person.email }),
  };

  const preview = useQuery({
    queryKey: templateKeys.preview(currentWorkspaceId, version?.id ?? '', contact),
    queryFn: () => templateApi.preview(version?.id ?? '', contact),
    enabled: version !== undefined,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: templateKeys.scoped(currentWorkspaceId) });
    void queryClient.invalidateQueries({ queryKey: templateKeys.all });
  };

  const save = useMutation({
    mutationFn: () =>
      templateApi.saveVersion(templateId, {
        subject: draft.subject,
        html: draft.html,
        ...(draft.preheader === '' ? {} : { preheader: draft.preheader }),
        ...(draft.textEdited ? { text: draft.text } : {}),
      }),
    onSuccess: (saved) => {
      setSelectedId(saved.id);
      invalidate();
    },
  });

  const publish = useMutation({
    mutationFn: () => templateApi.publish(version?.id ?? ''),
    onSuccess: invalidate,
  });

  const restore = useMutation({
    mutationFn: (source: TemplateVersion) =>
      templateApi.saveVersion(templateId, {
        subject: source.subject,
        html: source.htmlSource,
        text: source.textBody,
        ...(source.preheader === null ? {} : { preheader: source.preheader }),
      }),
    onSuccess: (saved) => {
      setSelectedId(saved.id);
      invalidate();
    },
  });

  const sendTest = useMutation({
    // BACKEND PENDING: POST /templates/versions/:versionId/test
    mutationFn: () => templateApi.sendTest(version?.id ?? '', testTo),
  });

  const saveSettings = useMutation({
    // BACKEND PENDING: PATCH /templates/:id accepts `name` only.
    mutationFn: (next: { defaultSenderId: string; language: string }) =>
      templateApi.updateSettings(templateId, next),
    onSuccess: invalidate,
  });

  const canWrite = can('template:write') && !readOnly;
  const writeReason = readOnly ? 'Workspace is read-only' : 'Your role cannot change templates';
  const editable = canWrite && !published;

  const lint = lintHtml(draft.html);

  const closeTest = (): void => {
    const next = new URLSearchParams(params);
    next.delete('test');
    setParams(next, { replace: true });
    sendTest.reset();
  };

  const openTest = (): void => {
    const next = new URLSearchParams(params);
    next.set('test', '1');
    setParams(next, { replace: true });
  };

  const insertTag = (token: string): void => {
    setShowTags(false);
    const field = htmlRef.current;

    if (field === null) {
      setDraft((current) => ({ ...current, html: `${current.html}${token}` }));
      return;
    }

    const start = field.selectionStart;
    const end = field.selectionEnd;
    setDraft((current) => ({
      ...current,
      html: `${current.html.slice(0, start)}${token}${current.html.slice(end)}`,
    }));

    // The caret belongs after the tag the author just asked for, not at the
    // top of the document.
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + token.length, start + token.length);
    });
  };

  if (version === undefined) {
    return (
      <ErrorState
        title="This template has no versions"
        description="Every template is created with a first draft, so this one is in an impossible state. Send support the workspace and the template id."
        requestId={templateId}
      />
    );
  }

  const senderRows = senders.data ?? [];
  const sender = senderRows.find((entry) => entry.id === settings.defaultSenderId) ?? senderRows[0];
  const fromName = preview.data?.fromName ?? sender?.fromName ?? template.name;
  const fromEmail = preview.data?.fromEmail ?? sender?.fromEmail ?? '';

  return (
    <>
      {/* The F2 header: back link, name, the version badge and the saved line,
          then the four actions. */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to="/templates" className="text-ui font-medium text-brand no-underline hover:underline">
            &larr; Templates
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2.5">
            <h1 className="m-0 min-w-0 text-title font-semibold leading-heading tracking-heading">
              {template.name}
            </h1>
            <Badge tone={published ? 'success' : 'neutral'}>
              {`v${version.version} · ${published ? 'Published' : 'Draft'}`}
            </Badge>
            <span className="text-caption text-text-2">
              {`${version.savedLabel ?? version.publishedLabel ?? 'Saved'} · `}
              <span className="font-mono">{template.id}</span>
            </span>
          </div>
        </div>

        <div className="flex flex-none flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            aria-pressed={showHistory}
            onClick={() => setShowHistory((open) => !open)}
            className={showHistory ? 'border-brand bg-brand-soft text-brand' : ''}
          >
            <ClockIcon />
            Version history
          </Button>

          <Button
            variant="secondary"
            pending={save.isPending}
            disabled={!canWrite}
            title={canWrite ? undefined : writeReason}
            onClick={() => save.mutate()}
          >
            Save draft
          </Button>

          <Button variant="secondary" onClick={openTest}>
            Send test
          </Button>

          <Button
            pending={publish.isPending}
            disabled={!canWrite || published}
            title={
              published
                ? 'Published versions are immutable'
                : canWrite
                  ? undefined
                  : writeReason
            }
            onClick={() => publish.mutate()}
          >
            {`Publish v${version.version}`}
          </Button>
        </div>
      </div>

      {save.isError || publish.isError ? (
        <p className="mb-4 rounded-control border border-border bg-danger-soft px-3 py-2 text-ui text-danger-text">
          {sentence(save.error ?? publish.error)}
        </p>
      ) : null}

      <div
        className={`grid items-stretch gap-4 ${
          showHistory
            ? 'lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_300px]'
            : 'lg:grid-cols-2'
        }`}
      >
        {/* ------------------------------------------------------ source -- */}
        <section className="flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface">
          <Tabs
            variant="card"
            label="Template source"
            value={tab}
            onChange={setTab}
            items={[
              { key: 'html', label: 'HTML' },
              { key: 'text', label: 'Plain text' },
              { key: 'settings', label: 'Settings' },
            ]}
            actions={
              tab !== 'html' ? null : (
                <span className="relative my-1.5">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={showTags}
                    disabled={!editable}
                    title={editable ? undefined : published ? 'Published versions are immutable' : writeReason}
                    onClick={() => setShowTags((open) => !open)}
                    className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 text-caption font-medium text-text disabled:cursor-not-allowed disabled:text-text-3"
                  >
                    Insert merge tag
                    <Icon name="chevronDown" size={12} strokeWidth={2} className="text-text-2" />
                  </button>

                  {!showTags ? null : (
                    <div
                      role="menu"
                      aria-label="Merge tags"
                      className="absolute top-[38px] right-0 z-10 w-90 max-w-[calc(100vw-2rem)] rounded-card border border-border bg-surface p-1.5 text-ui shadow-overlay"
                    >
                      <div className="px-2.5 pt-2 pb-1.5 text-label font-semibold tracking-label text-text-3 uppercase">
                        Merge tags · fallback in quotes
                      </div>
                      {MERGE_TAGS.map((entry) => (
                        <button
                          key={entry.token}
                          type="button"
                          role="menuitem"
                          onClick={() => insertTag(entry.token)}
                          className="flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-control px-2.5 py-2 text-left hover:bg-tint"
                        >
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate font-mono text-caption text-brand">
                              {entry.token}
                            </span>
                            <span className="text-caption text-text-2">{entry.hint}</span>
                          </span>
                          {entry.required === true ? <RequiredChip /> : null}
                        </button>
                      ))}
                    </div>
                  )}
                </span>
              )
            }
          />

          {published ? (
            <p className="m-0 border-b border-border bg-tint px-3.5 py-2 text-caption text-text-2">
              {`v${version.version} is published and immutable — a campaign that sent it records this exact version. Save draft writes v${(newest?.version ?? version.version) + 1}.`}
            </p>
          ) : null}

          {tab === 'html' ? (
            <>
              <CodeEditor
                id="template-html"
                label="Template HTML"
                value={draft.html}
                readOnly={!editable}
                textareaRef={htmlRef}
                onChange={(value) => setDraft((current) => ({ ...current, html: value }))}
              />
              <LintBar lint={lint} />
            </>
          ) : tab === 'text' ? (
            <>
              <CodeEditor
                id="template-text"
                label="Plain-text version"
                value={draft.text}
                readOnly={!editable}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, text: value, textEdited: true }))
                }
              />
              <p className="m-0 border-t border-border px-3.5 py-2 text-caption text-text-2">
                {draft.textEdited
                  ? 'Edited by hand. It will be sent as written.'
                  : 'Generated from the HTML. Edit it to take over.'}
              </p>
            </>
          ) : (
            <div className="grid gap-x-5 gap-y-4.5 p-5 text-ui sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field
                  label="Subject"
                  value={draft.subject}
                  readOnly={!editable}
                  help="Merge tags work here too. Campaigns can override the subject."
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, subject: event.target.value }))
                  }
                />
              </div>

              <div className="sm:col-span-2">
                <Field
                  label="Preheader"
                  value={draft.preheader}
                  readOnly={!editable}
                  help={`Shown after the subject in most inboxes. ${draft.preheader.length} characters.`}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, preheader: event.target.value }))
                  }
                />
              </div>

              {/* BACKEND PENDING: PATCH /templates/:id (defaultSenderId) */}
              <Select
                label="Default sender"
                value={settings.defaultSenderId}
                disabled={!canWrite}
                onChange={(event) => {
                  const next = { ...settings, defaultSenderId: event.target.value };
                  setSettings(next);
                  saveSettings.mutate(next);
                }}
              >
                <option value="">Choose a sender…</option>
                {senderRows.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {`${entry.fromName} <${entry.fromEmail}>`}
                  </option>
                ))}
              </Select>

              {/* BACKEND PENDING: PATCH /templates/:id (language) */}
              <Select
                label="Language"
                value={settings.language}
                disabled={!canWrite}
                onChange={(event) => {
                  const next = { ...settings, language: event.target.value };
                  setSettings(next);
                  saveSettings.mutate(next);
                }}
              >
                {LANGUAGES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </Select>

              <div className="flex flex-col gap-2.5 rounded-control border border-border px-3.5 py-3 sm:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5">
                    <span className="font-medium">Unsubscribe link</span>
                    <LockChip>Always on</LockChip>
                  </span>
                  {lint.unsubscribeLine === null ? (
                    <span className="ml-auto text-caption font-medium text-danger-text">
                      Missing from the HTML
                    </span>
                  ) : (
                    <span className="ml-auto text-caption font-medium text-success-text">
                      {`Present in HTML · line ${lint.unsubscribeLine}`}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5">
                    <span className="font-medium">List-Unsubscribe header</span>
                    <LockChip>Always on</LockChip>
                  </span>
                  <span className="ml-auto text-caption text-text-2">
                    RFC 8058 one-click, added at send time
                  </span>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* ----------------------------------------------------- preview -- */}
        <section className="flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-caption">
            <InlineSelect label="Preview as" size="sm" value={personId} onChange={setPersonId}>
              {PREVIEW_PEOPLE.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </InlineSelect>

            <SegmentedToggle label="Preview width" value={device} options={DEVICES} onChange={setDevice} />
          </div>

          <div className="flex flex-1 justify-center overflow-auto bg-bg p-5">
            {preview.isError ? (
              <ErrorState
                size="table"
                title="We couldn't render the preview"
                description={sentence(preview.error)}
                {...requestId(preview.error)}
                onRetry={() => void preview.refetch()}
                retryLabel="Retry"
                className="w-full"
              />
            ) : (
              <div
                className="w-full self-start overflow-hidden rounded-card border border-border bg-white shadow-overlay"
                style={device === 'mobile' ? { width: 375 } : { maxWidth: 640 }}
              >
                {/*
                  The inbox line: who it is from, the subject and the
                  preheader, exactly what a reader decides on.

                  Fixed colours rather than tokens, and deliberately: this is
                  the mail client's own chrome around a white email, and F2c
                  keeps it light in dark mode. Themed text here would be
                  invisible on the white card.
                */}
                <div className="px-4 py-2.5 text-caption" style={INBOX}>
                  <div className="truncate">
                    <span className="font-medium" style={INBOX_STRONG}>
                      {fromName}
                    </span>
                    {fromEmail === '' ? null : ` <${fromEmail}>`}
                  </div>
                  <div className="mt-0.5 truncate" style={INBOX_STRONG}>
                    {preview.data?.subject ?? draft.subject}
                  </div>
                  <div className="truncate" style={INBOX_MUTED}>
                    {preview.data?.preheader ?? draft.preheader}
                  </div>
                </div>

                {/*
                  docs/06: "Previews render in a sandboxed iframe on a separate
                  origin, never on the app origin, or a malicious template
                  steals sessions." `srcDoc` with a `sandbox` that omits
                  `allow-same-origin` gives the frame a unique opaque origin —
                  it can reach neither our cookies nor our DOM. `allow-scripts`
                  is omitted too: a template has no legitimate script, the
                  sanitiser strips any it finds, and allowing both together
                  would undo the sandbox entirely.
                */}
                <iframe
                  title="Email preview"
                  sandbox=""
                  srcDoc={preview.data?.html ?? ''}
                  className="block h-[560px] w-full border-0 bg-white"
                />
              </div>
            )}
          </div>
        </section>

        {/* ----------------------------------------------------- history -- */}
        {showHistory ? (
          <section className="flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface lg:col-span-2 xl:col-span-1">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-ui font-semibold">Version history</span>
              <span className="text-caption text-text-2">
                {versions.length === 1 ? '1 version' : `${versions.length} versions`}
              </span>
            </div>

            <div className="flex-1 overflow-auto p-2">
              {versions.map((entry) => {
                const selected = entry.id === version.id;
                const entryPublished = entry.publishedAt !== null;

                return (
                  <article
                    key={entry.id}
                    aria-current={selected ? 'true' : undefined}
                    className={`mb-2 rounded-control border p-3 ${
                      selected ? 'border-brand bg-brand-soft' : 'border-border bg-surface'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <span className="text-ui font-semibold">{`v${entry.version}`}</span>
                        <Badge tone={entryPublished ? 'success' : 'neutral'}>
                          {entryPublished ? 'Published' : 'Draft'}
                        </Badge>
                      </span>
                      {entryPublished ? (
                        <span title="Published versions are immutable" className="grid text-text-3">
                          <Icon name="lock" size={13} strokeWidth={2} />
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-1 text-caption text-text-2">
                      {entryPublished
                        ? (entry.publishedLabel ?? 'Published')
                        : (entry.historyLabel ?? entry.savedLabel ?? 'Draft')}
                    </div>

                    {(entry.campaigns ?? []).length === 0 ? (
                      entryPublished ? (
                        <div className="mt-1.5 text-caption text-text-3">Not used by any campaign</div>
                      ) : null
                    ) : (
                      <div className="mt-2 flex flex-col gap-1">
                        {(entry.campaigns ?? []).map((campaign) => (
                          <Link
                            key={campaign.id}
                            to={`/campaigns/${campaign.id}`}
                            className="flex items-center justify-between gap-2 text-caption text-text no-underline hover:underline"
                          >
                            <span className="truncate">{campaign.name}</span>
                            <StateBadge states={CAMPAIGN_STATES} state={campaign.status} />
                          </Link>
                        ))}
                      </div>
                    )}

                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {selected ? (
                        <span className="text-label text-text-2">
                          {entryPublished ? 'Viewing this version' : 'Editing now · publish to lock'}
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => setSelectedId(entry.id)}
                            className="h-6.5 cursor-pointer rounded-badge border border-border bg-surface px-2 text-label font-medium text-text hover:bg-tint"
                          >
                            View
                          </button>
                          <button
                            type="button"
                            disabled={!canWrite}
                            title={canWrite ? undefined : writeReason}
                            onClick={() => restore.mutate(entry)}
                            className="h-6.5 cursor-pointer rounded-badge border border-border bg-surface px-2 text-label font-medium text-text hover:bg-tint disabled:cursor-not-allowed disabled:text-text-3"
                          >
                            Restore as new draft
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>

      <Modal
        open={testOpen}
        onClose={closeTest}
        title="Send test"
        description={`One copy of v${version.version}, rendered with sample contact details. It is not billed and no contact is touched.`}
        footer={
          <>
            <Button variant="secondary" onClick={closeTest}>
              Cancel
            </Button>
            <Button
              pending={sendTest.isPending}
              disabled={testTo.trim() === ''}
              title={testTo.trim() === '' ? 'Enter an address to send to' : undefined}
              onClick={() => sendTest.mutate()}
            >
              Send test
            </Button>
          </>
        }
      >
        <Field
          label="Send to"
          type="email"
          value={testTo}
          onChange={(event) => setTestTo(event.target.value)}
          help="Your own address, or a seed list address."
          {...(sendTest.isError ? { error: sentence(sendTest.error) } : {})}
        />
        {sendTest.isSuccess ? (
          <p className="mt-2 mb-0 text-ui text-success-text">{`Test sent to ${testTo}.`}</p>
        ) : null}
      </Modal>
    </>
  );
}
