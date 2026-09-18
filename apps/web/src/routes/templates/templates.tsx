import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import {
  STANDARD_MERGE_TAGS,
  templateApi,
  templateKeys,
  type Preview,
  type TemplateVersion,
} from '../../api/templates.js';
import { IfPermitted } from '../../auth/guards.js';
import { Badge, Button, Cell, EmptyState, LoadError, Loading, Page, Table, formatDate } from '../../components/ui.js';

/**
 * Templates.
 *
 * An HTML editor with a merge-tag picker, a desktop and mobile preview, and a
 * plain-text editor. No drag-and-drop builder — BUILD-PLAN says so in bold,
 * and docs/15 explains why: it is a quarter of work on its own.
 */

export function TemplatesPage() {
  const queryClient = useQueryClient();

  const templates = useQuery({ queryKey: templateKeys.all, queryFn: templateApi.list });

  const remove = useMutation({
    mutationFn: (id: string) => templateApi.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: templateKeys.all });
    },
  });

  return (
    <Page
      title="Templates"
      description="The content your campaigns send."
      action={
        <IfPermitted permission="template:write">
          <Link
            to="/templates/create"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            New template
          </Link>
        </IfPermitted>
      }
    >
      {templates.isPending ? (
        <Loading />
      ) : templates.isError ? (
        <LoadError error={templates.error} onRetry={() => void templates.refetch()} />
      ) : templates.data.length === 0 ? (
        <EmptyState title="No templates yet">
          A template is an email you can send to a list or a segment.
        </EmptyState>
      ) : (
        <Table columns={['Name', 'Published', 'Updated', '']} caption="Templates">
          {templates.data.map((template) => (
            <tr key={template.id}>
              <Cell>
                <Link to={`/templates/${template.id}`} className="underline">
                  {template.name}
                </Link>
              </Cell>
              <Cell>
                {template.currentVersionId === null ? (
                  <Badge tone="neutral">Draft only</Badge>
                ) : (
                  <Badge tone="good">Published</Badge>
                )}
              </Cell>
              <Cell muted>{formatDate(template.updatedAt)}</Cell>
              <Cell>
                <IfPermitted permission="template:write">
                  <div className="flex justify-end">
                    <Button variant="danger" onClick={() => remove.mutate(template.id)}>
                      Delete
                    </Button>
                  </div>
                </IfPermitted>
              </Cell>
            </tr>
          ))}
        </Table>
      )}
    </Page>
  );
}

export function CreateTemplatePage() {
  const navigate = useNavigate();

  const create = useMutation({
    mutationFn: templateApi.create,
    onSuccess: (result) => navigate(`/templates/${result.template.id}`),
  });

  return (
    <Page title="New template" description="Write the email. You can preview it before publishing.">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);

          create.mutate({
            name: String(data.get('name') ?? '').trim(),
            subject: String(data.get('subject') ?? '').trim(),
            html: String(data.get('html') ?? ''),
          });
        }}
      >
        <div className="space-y-1">
          <label htmlFor="template-name" className="block text-sm font-medium text-slate-800">
            Name
          </label>
          <input
            id="template-name"
            name="name"
            required
            maxLength={120}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="template-subject" className="block text-sm font-medium text-slate-800">
            Subject
          </label>
          <input
            id="template-subject"
            name="subject"
            required
            maxLength={200}
            defaultValue="Hi {{ first_name | there }}"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="template-html" className="block text-sm font-medium text-slate-800">
            HTML
          </label>
          <textarea
            id="template-html"
            name="html"
            required
            rows={12}
            defaultValue={'<p>Hello {{ first_name | there }},</p>\n<p>Write your message here.</p>'}
            className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
          />
        </div>

        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>

        {create.isError && <LoadError error={create.error} />}
      </form>
    </Page>
  );
}

export function TemplateEditorPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();

  const template = useQuery({
    queryKey: templateKeys.one(id),
    queryFn: () => templateApi.get(id),
    enabled: id !== '',
  });

  if (template.isPending) return <Loading />;
  if (template.isError) return <Page title="Template"><LoadError error={template.error} /></Page>;

  const latest = template.data.versions[0];
  if (latest === undefined) {
    return (
      <Page title={template.data.template.name}>
        <EmptyState title="This template has no versions" />
      </Page>
    );
  }

  return (
    <Editor
      templateId={id}
      name={template.data.template.name}
      version={latest}
      versions={template.data.versions}
      onSaved={() => {
        void queryClient.invalidateQueries({ queryKey: templateKeys.one(id) });
      }}
    />
  );
}

function Editor({
  templateId,
  name,
  version,
  versions,
  onSaved,
}: {
  templateId: string;
  name: string;
  version: TemplateVersion;
  versions: TemplateVersion[];
  onSaved: () => void;
}) {
  const [subject, setSubject] = useState(version.subject);
  const [html, setHtml] = useState(version.htmlSource);
  const [text, setText] = useState(version.textBody);
  const [textEdited, setTextEdited] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [width, setWidth] = useState<'desktop' | 'mobile'>('desktop');

  const published = version.publishedAt !== null;

  const save = useMutation({
    mutationFn: () =>
      templateApi.saveVersion(templateId, {
        subject,
        html,
        ...(textEdited ? { text } : {}),
      }),
    onSuccess: onSaved,
  });

  const publish = useMutation({
    mutationFn: () => templateApi.publish(version.id),
    onSuccess: onSaved,
  });

  const runPreview = useMutation({
    mutationFn: () => templateApi.preview(version.id),
    onSuccess: setPreview,
  });

  /** Inserts a tag at the end of the HTML, which is where the caret is not. */
  const insertTag = (field: string, suggestedDefault: string): void => {
    const tag = suggestedDefault === '' ? `{{ ${field} }}` : `{{ ${field} | ${suggestedDefault} }}`;
    setHtml((current) => `${current}${tag}`);
  };

  return (
    <Page
      title={name}
      description={`Version ${version.version}${published ? ' — published and immutable' : ' — draft'}`}
      action={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => runPreview.mutate()}>
            {runPreview.isPending ? 'Rendering…' : 'Preview'}
          </Button>
          <IfPermitted permission="template:write">
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : published ? 'Save as new version' : 'Save draft'}
            </Button>
            {!published && (
              <Button variant="secondary" disabled={publish.isPending} onClick={() => publish.mutate()}>
                Publish
              </Button>
            )}
          </IfPermitted>
        </div>
      }
    >
      {published && (
        <p className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
          This version is published, so it cannot be changed — a campaign that sent it records this
          exact version. Saving creates version {(versions[0]?.version ?? 0) + 1}.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="editor-subject" className="block text-sm font-medium text-slate-800">
              Subject
            </label>
            <input
              id="editor-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <MergeTagPicker onInsert={insertTag} used={version.variables} />

          <div className="space-y-1">
            <label htmlFor="editor-html" className="block text-sm font-medium text-slate-800">
              HTML
            </label>
            <textarea
              id="editor-html"
              value={html}
              onChange={(event) => setHtml(event.target.value)}
              rows={18}
              spellCheck={false}
              className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="editor-text" className="block text-sm font-medium text-slate-800">
              Plain text
            </label>
            <p className="text-xs text-slate-500">
              {textEdited
                ? 'Edited by hand. It will be sent as written.'
                : 'Generated from the HTML. Edit it to take over.'}
            </p>
            <textarea
              id="editor-text"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setTextEdited(true);
              }}
              rows={8}
              className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
            />
          </div>

          {save.isError && <LoadError error={save.error} />}
          {publish.isError && <LoadError error={publish.error} />}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Preview</h2>
            <div className="flex gap-1">
              <Button
                variant={width === 'desktop' ? 'primary' : 'secondary'}
                onClick={() => setWidth('desktop')}
              >
                Desktop
              </Button>
              <Button
                variant={width === 'mobile' ? 'primary' : 'secondary'}
                onClick={() => setWidth('mobile')}
              >
                Mobile
              </Button>
            </div>
          </div>

          {preview === null ? (
            <EmptyState title="Nothing rendered yet">
              Press Preview to see this version with sample contact details.
            </EmptyState>
          ) : (
            <PreviewFrame preview={preview} width={width} />
          )}
        </div>
      </div>
    </Page>
  );
}

function MergeTagPicker({
  onInsert,
  used,
}: {
  onInsert: (field: string, suggestedDefault: string) => void;
  used: TemplateVersion['variables'];
}) {
  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <p className="text-sm font-medium text-slate-800">Merge tags</p>

      <div className="flex flex-wrap gap-2">
        {STANDARD_MERGE_TAGS.map((tag) => (
          <Button
            key={tag.field}
            variant="secondary"
            onClick={() => onInsert(tag.field, tag.suggestedDefault)}
          >
            {tag.label}
          </Button>
        ))}
      </div>

      <p className="text-xs text-slate-600">
        {/*
          The default is what a contact without the field will see. Saying so
          here is the whole reason a default exists — a campaign that goes out
          saying "Hi ," is the most visible way this goes wrong.
        */}
        Write <code className="rounded bg-white px-1">{'{{ field | fallback }}'}</code> to choose
        what a contact without that field sees. For a custom attribute, use its name.
      </p>

      {used.length > 0 && (
        <p className="text-xs text-slate-600">
          In use:{' '}
          {used.map((tag) => (
            <span key={tag.field} className="mr-2">
              <code className="rounded bg-white px-1">{tag.field}</code>
              {tag.required && <span className="text-amber-700"> (no fallback)</span>}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/**
 * The preview, isolated.
 *
 * docs/06: "Previews render in a sandboxed iframe on a separate origin, never
 * on the app origin, or a malicious template steals sessions."
 *
 * `srcDoc` with a `sandbox` attribute that omits `allow-same-origin` gives the
 * frame a unique opaque origin — it can reach neither our cookies nor our DOM,
 * which is the property the separate origin was for. `allow-scripts` is also
 * omitted: a template has no legitimate script, the sanitiser strips any it
 * finds, and allowing both together would undo the sandbox entirely.
 */
function PreviewFrame({ preview, width }: { preview: Preview; width: 'desktop' | 'mobile' }) {
  return (
    <div className="space-y-2">
      <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
        <p className="text-xs text-slate-500">Subject</p>
        <p className="text-sm text-slate-900">{preview.subject}</p>
      </div>

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-slate-100 p-2">
        <iframe
          title="Email preview"
          sandbox=""
          srcDoc={preview.html}
          className="block border-0 bg-white"
          style={{ width: width === 'mobile' ? 375 : '100%', height: 600 }}
        />
      </div>

      <details className="rounded-md border border-slate-200 bg-white p-3">
        <summary className="cursor-pointer text-sm text-slate-800">Plain text version</summary>
        <pre className="mt-2 whitespace-pre-wrap text-xs text-slate-700">{preview.text}</pre>
      </details>

      <p className="text-xs text-slate-500">
        Rendered from version {preview.version}
        {preview.published ? ' (published)' : ' (draft)'} — id{' '}
        <code className="rounded bg-slate-100 px-1">{preview.templateVersionId}</code>
      </p>
    </div>
  );
}
