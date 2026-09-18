import { discoverMergeTags, renderMergeTags, type MergeTag, type RenderContext } from './merge-tags.js';
import { sanitiseTemplateHtml } from './sanitise.js';

/**
 * Compiling and rendering a template.
 *
 * Two separate operations, and keeping them separate is the point:
 *
 *   *Compiling* happens once, when a version is saved. It sanitises the HTML
 *   and derives the plain-text body, and the result is stored. It is the only
 *   step that can be expensive.
 *
 *   *Rendering* happens once per recipient, on the send path, against
 *   already-compiled output. It substitutes merge tags and nothing else.
 *
 * Merging the two would mean sanitising 500,000 times per campaign, and worse:
 * re-sanitising at send time means a template sent today and the same template
 * sent tomorrow can differ, because the allowlist changed in between. The
 * compiled output is what was reviewed and what is sent.
 */

export interface CompileInput {
  subject: string;
  preheader?: string;
  html: string;
  /** Supplied by the author, or derived from the HTML when absent. */
  text?: string;
}

export interface CompiledTemplate {
  subject: string;
  preheader: string | null;
  htmlCompiled: string;
  textBody: string;
  variables: MergeTag[];
  /** What sanitisation removed, for the editor to report. */
  removed: string[];
}

export function compileTemplate(input: CompileInput): CompiledTemplate {
  const { html, removed } = sanitiseTemplateHtml(input.html);

  // Derived from the sanitised HTML, never the source: otherwise a payload
  // stripped from the HTML survives in the text part, which several clients
  // render preferentially.
  const textBody = input.text?.trim() === '' || input.text === undefined ? htmlToText(html) : input.text;

  return {
    subject: input.subject,
    preheader: input.preheader ?? null,
    htmlCompiled: html,
    textBody,
    // Discovered across every part a recipient sees, so a tag used only in
    // the subject is still recorded and still checked at launch.
    variables: discoverMergeTags(input.subject, input.preheader ?? '', html, textBody),
    removed,
  };
}

export interface RenderedMessage {
  subject: string;
  html: string;
  text: string;
}

/**
 * Renders a compiled template for one recipient.
 *
 * Deterministic: no clock, no randomness, no network. The same version and the
 * same contact produce byte-identical output, which is what makes a campaign
 * report reproducible and a rendering bug reproducible with it.
 */
export function renderTemplate(
  compiled: Pick<CompiledTemplate, 'subject' | 'htmlCompiled' | 'textBody' | 'preheader'>,
  context: RenderContext,
): RenderedMessage {
  const html = renderMergeTags(compiled.htmlCompiled, context, 'html');

  return {
    // The subject is not HTML. Escaping it would send "Ben &amp; Jerry's" to
    // an inbox, which is a bug customers notice within the hour.
    subject: renderMergeTags(compiled.subject, context, 'text'),
    html:
      compiled.preheader === null || compiled.preheader === ''
        ? html
        : withPreheader(html, renderMergeTags(compiled.preheader, context, 'html')),
    text: renderMergeTags(compiled.textBody, context, 'text'),
  };
}

/**
 * Inserts the preheader.
 *
 * The hidden-span trick: clients show the first text in the body as the
 * preview line, so it goes first and is hidden. The run of zero-width
 * non-joiners after it stops the client pulling the next real sentence into
 * the preview alongside it.
 */
function withPreheader(html: string, preheader: string): string {
  const hidden =
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">` +
    `${preheader}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>`;

  // After <body> if there is one, so the preheader is inside the document.
  const bodyOpen = /<body\b[^>]*>/iu.exec(html);
  if (bodyOpen !== null) {
    const at = bodyOpen.index + bodyOpen[0].length;
    return html.slice(0, at) + hidden + html.slice(at);
  }

  return hidden + html;
}

/**
 * Derives a plain-text body from sanitised HTML.
 *
 * Not a general HTML-to-text converter: it only has to handle the tags the
 * sanitiser allows, which is why it is a few substitutions rather than a
 * parser. A text part is not optional — a message with no text alternative
 * scores worse with every spam filter, and docs/04 stage 3 requires one.
 */
export function htmlToText(html: string): string {
  let text = html;

  // Anything the sanitiser would have stripped, in case this is called on
  // unsanitised input by mistake.
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, '');

  // A link becomes "text (url)", because a plain-text reader cannot click a
  // word. Skipped when the text already is the URL.
  //
  // Parentheses rather than angle brackets: stripTags runs afterwards and
  // would read <https://example.com> as a tag, removing the URL that had just
  // been added.
  text = text.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu,
    (_whole, href: string, label: string) => {
      const plain = stripTags(label).trim();
      return plain === '' || plain === href ? href : `${plain} (${href})`;
    },
  );

  text = text
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|blockquote|li)>/giu, '\n')
    .replace(/<li\b[^>]*>/giu, '- ')
    .replace(/<\/(td|th)>/giu, '\t')
    .replace(/<hr\s*\/?>/giu, '\n---\n');

  text = stripTags(text);
  text = decodeEntities(text);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/gu, ' ').trim())
    // Collapse runs of blank lines to one: table-based email layout produces
    // dozens, and a text part that is mostly whitespace looks broken.
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/gu, '');
}

/**
 * Decodes the entities the sanitiser emits.
 *
 * `&amp;` last, deliberately. Decoding it first would turn `&amp;lt;` into
 * `&lt;` and then into `<`, reintroducing markup into the text part.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gu, ' ')
    .replace(/&zwnj;/gu, '')
    .replace(/&#847;/gu, '')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}
