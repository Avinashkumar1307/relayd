import sanitizeHtml from 'sanitize-html';

/**
 * Server-side HTML sanitisation for email templates (docs/06 section 12).
 *
 * The threat is not the customer's own inbox. A template is authored by one
 * member of a workspace and *previewed* by others, so an unsanitised template
 * is stored XSS against colleagues — and docs/06 pairs this with rendering
 * previews in a sandboxed iframe on a separate origin for exactly that reason.
 * Sanitisation is the half that must not be skipped, because the preview
 * origin is one deploy mistake away from being the app origin.
 *
 * `sanitize-html` is used rather than a hand-written parser. Writing one is a
 * standing invitation to mutation XSS: the attacks that work are the ones
 * where the browser's parser disagrees with yours about where a tag ends, and
 * only a real tokeniser gets that right. Recorded in docs/16.
 *
 * The allowlist is deliberately smaller than a web page's. Email clients strip
 * most of it anyway, and every tag that survives is a tag an attacker can try.
 */

/**
 * Tags an email actually needs.
 *
 * No `script`, `iframe`, `object`, `embed`, `form`, `input`, `button`,
 * `svg` or `math`. The last two are not paranoia: SVG and MathML switch the
 * parser into foreign-content mode, where the rules about what closes a tag
 * change, and that difference is the basis of most mutation XSS.
 */
const ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  // Tables are how email layout is still done.
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  // Structural wrappers, kept so a full document round-trips.
  'body',
  'center',
  'font',
];

/**
 * Attributes, per tag.
 *
 * `style` is allowed because email layout depends on inline styles, and is
 * filtered separately below. No `on*` handler is listed, and sanitize-html
 * drops anything not listed — but the explicit check in `hasEventHandler`
 * exists so a future widening of this list cannot quietly admit one.
 */
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ['href', 'name', 'target', 'title', 'style', 'rel'],
  img: ['src', 'alt', 'title', 'width', 'height', 'style', 'border'],
  table: ['width', 'border', 'cellpadding', 'cellspacing', 'align', 'style', 'role'],
  td: ['width', 'height', 'align', 'valign', 'colspan', 'rowspan', 'style', 'bgcolor'],
  th: ['width', 'height', 'align', 'valign', 'colspan', 'rowspan', 'style', 'bgcolor'],
  tr: ['align', 'valign', 'style', 'bgcolor'],
  font: ['color', 'face', 'size'],
  '*': ['style', 'class', 'align', 'dir', 'lang'],
};

/**
 * Schemes a link may use.
 *
 * `javascript:` and `data:` are absent, and both matter. A `data:` URL in an
 * href renders as a page under our origin's opener in some clients, and it is
 * the standard way to smuggle HTML past a scheme check.
 */
const ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'tel'];

/**
 * CSS properties an email may set.
 *
 * Restricted rather than open because `expression()`, `behavior`, `-moz-binding`
 * and `url()` have all been script execution vectors, and because a template
 * that can set `position: fixed` can cover the preview UI around it.
 *
 * Enforced by filterStyle() below rather than by sanitize-html's own
 * `allowedStyles`. Setting both filters twice, and the second pass runs after
 * transformTags — an empty allowlist there silently discards everything the
 * first pass had just approved.
 */
const SAFE_STYLE_PROPERTIES = new Set([
  'background',
  'background-color',
  'border',
  'border-bottom',
  'border-collapse',
  'border-color',
  'border-left',
  'border-radius',
  'border-right',
  'border-spacing',
  'border-style',
  'border-top',
  'border-width',
  'color',
  'display',
  'font',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'height',
  'letter-spacing',
  'line-height',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-width',
  'min-width',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'text-align',
  'text-decoration',
  'text-transform',
  'vertical-align',
  'width',
  'word-break',
  'word-wrap',
]);

/** Values that have been script vectors regardless of the property. */
const DANGEROUS_STYLE_VALUE = /expression\s*\(|javascript\s*:|behaviou?r\s*:|-moz-binding|url\s*\(/iu;

export interface SanitiseResult {
  html: string;
  /** What was removed, so the editor can say so rather than silently differ. */
  removed: string[];
}

/**
 * Sanitises a template's HTML.
 *
 * Reports what it removed. An author whose tracking snippet silently vanished
 * will otherwise assume the product is broken, and an author whose payload
 * silently vanished should be told we noticed.
 */
export function sanitiseTemplateHtml(source: string): SanitiseResult {
  const removed = new Set<string>();

  const html = sanitizeHtml(source, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ALLOWED_SCHEMES,
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    // A relative URL in an email resolves against nothing useful, and is a
    // common way to smuggle a scheme past a naive check.
    allowProtocolRelative: false,
    // Comments can carry conditional comments, which older Outlook executes.
    allowedClasses: false as never,
    disallowedTagsMode: 'discard',

    exclusiveFilter: (frame) => {
      if (hasEventHandler(frame.attribs)) {
        removed.add('event handler');
        return true;
      }
      return false;
    },

    transformTags: {
      '*': (tagName, attribs) => {
        const cleaned: Record<string, string> = {};

        for (const [name, value] of Object.entries(attribs)) {
          const lower = name.toLowerCase();

          // Belt and braces over the allowlist: on* never reaches output,
          // whatever a future widening of ALLOWED_ATTRIBUTES permits.
          if (lower.startsWith('on')) {
            removed.add('event handler');
            continue;
          }

          if (lower === 'style') {
            const safe = filterStyle(value);
            if (safe !== value) removed.add('unsafe style');
            if (safe !== '') cleaned[name] = safe;
            continue;
          }

          cleaned[name] = value;
        }

        // Every external link opens in a new context without handing it a
        // window reference. `noopener` is not optional on target=_blank.
        if (tagName === 'a' && cleaned['target'] !== undefined) {
          cleaned['rel'] = 'noopener noreferrer';
        }

        return { tagName, attribs: cleaned };
      },
    },
  });

  // Reported after the fact by comparing shapes, because sanitize-html does
  // not tell us what it discarded.
  for (const tag of ['script', 'iframe', 'object', 'embed', 'form', 'svg', 'math', 'style', 'link', 'base', 'meta']) {
    if (new RegExp(`<\\s*${tag}\\b`, 'iu').test(source)) removed.add(`<${tag}>`);
  }

  return { html, removed: [...removed].sort() };
}

function hasEventHandler(attribs: Record<string, string>): boolean {
  return Object.keys(attribs).some((name) => name.toLowerCase().startsWith('on'));
}

/**
 * Keeps only allowlisted properties with values that cannot execute.
 *
 * Parsed by splitting on semicolons rather than with a CSS parser: the
 * allowlist is the guarantee, and anything this fails to parse is dropped
 * rather than passed through.
 */
export function filterStyle(style: string): string {
  const kept: string[] = [];

  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;

    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();

    if (property === '' || value === '') continue;
    if (!SAFE_STYLE_PROPERTIES.has(property)) continue;
    if (DANGEROUS_STYLE_VALUE.test(value)) continue;
    // A value containing a quote or angle bracket is trying to escape the
    // attribute it lives in.
    if (/["'<>]/u.test(value)) continue;

    kept.push(`${property}:${value}`);
  }

  return kept.join(';');
}
