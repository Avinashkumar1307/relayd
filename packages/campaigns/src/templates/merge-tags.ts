/**
 * Merge tags.
 *
 * The syntax is `{{ field }}` or `{{ field | default }}`. Deliberately small:
 * no expressions, no conditionals, no loops. A template language with logic in
 * it is a template language that can be made to leak another contact's data or
 * to loop forever inside the send path, and a customer who needs conditionals
 * needs two campaigns.
 *
 * Three rules decide everything here:
 *
 *   A missing field renders its configured default, never the literal token
 *   (BUILD-PLAN Phase 4 gate). "Hi {{ first_name }}" arriving as
 *   "Hi {{ first_name }}" is the single most visible way an email campaign
 *   goes wrong.
 *
 *   Rendering is deterministic. The same version and the same contact produce
 *   byte-identical output, because a campaign records the version it rendered
 *   and a report that cannot be reproduced is not evidence.
 *
 *   Substituted values are escaped for the context they land in. A contact's
 *   name is attacker-controlled — anyone can put anything in a signup form.
 */

export interface MergeTag {
  /** The field name, normalised. */
  field: string;
  /** Rendered when the field is missing or empty. */
  default: string;
  /** True when no default was written, so a launch check can warn. */
  required: boolean;
}

/**
 * The tag pattern.
 *
 * Whitespace is tolerated because authors write it. The field is restricted to
 * word characters and dots so a tag cannot name anything but a field —
 * `{{ ../../etc/passwd }}` is not a field.
 */
const TAG = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/gu;

/** Fields that come from the contact rather than its attributes. */
export const CONTACT_FIELDS = new Set(['email', 'first_name', 'last_name', 'id']);

/**
 * Finds every merge tag in a template.
 *
 * Returns one entry per distinct field. Where the same field appears twice
 * with different defaults the first wins, because rendering has to pick one
 * and the alternative — the same field rendering differently in the subject
 * and the body — is worse than an arbitrary choice.
 */
export function discoverMergeTags(...sources: string[]): MergeTag[] {
  const found = new Map<string, MergeTag>();

  for (const source of sources) {
    TAG.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TAG.exec(source)) !== null) {
      const field = (match[1] as string).toLowerCase();
      if (found.has(field)) continue;

      const fallback = match[2];
      found.set(field, {
        field,
        default: fallback ?? '',
        required: fallback === undefined,
      });
    }
  }

  return [...found.values()];
}

export interface RenderContext {
  /** Contact fields and attributes, already flattened and lowercased. */
  values: Readonly<Record<string, string>>;
  /** Defaults from the template version, by field. */
  defaults?: Readonly<Record<string, string>>;
}

export type EscapeMode = 'html' | 'text';

/**
 * Substitutes merge tags.
 *
 * Resolution order: the contact's value, then the tag's own default, then the
 * template version's recorded default, then empty. Empty rather than the
 * literal token, always — a campaign that goes out saying "Hi {{ first_name }}"
 * is worse than one saying "Hi".
 */
export function renderMergeTags(
  source: string,
  context: RenderContext,
  mode: EscapeMode = 'html',
): string {
  TAG.lastIndex = 0;

  return source.replace(TAG, (_whole, rawField: string, inlineDefault?: string) => {
    const field = rawField.toLowerCase();

    const value = context.values[field];
    const resolved =
      value !== undefined && value !== ''
        ? value
        : (inlineDefault ?? context.defaults?.[field] ?? '');

    return mode === 'html' ? escapeHtml(resolved) : resolved;
  });
}

/**
 * Escapes a substituted value for HTML.
 *
 * Applied to the *value*, never to the template — the template has already
 * been sanitised, and escaping it again would render its markup as text.
 *
 * Quotes are escaped as well as angle brackets, because a merge tag inside an
 * attribute (`<a href="/u/{{ token }}">`) is a real thing authors write, and
 * a value containing a quote would otherwise close the attribute.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Flattens a contact into the values a template can reference.
 *
 * Attributes are namespaced under their own names, so a custom attribute
 * called `email` cannot shadow the contact's actual address — which would let
 * an imported CSV column change who an unsubscribe link belongs to.
 */
export function contactValues(contact: {
  id?: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  attributes?: Readonly<Record<string, unknown>>;
}): Record<string, string> {
  const values: Record<string, string> = {};

  // Attributes first, so the contact's own fields overwrite any collision.
  for (const [key, value] of Object.entries(contact.attributes ?? {})) {
    if (value === null || value === undefined) continue;
    values[key.toLowerCase()] = String(value);
  }

  values['email'] = contact.email;
  values['first_name'] = contact.firstName ?? '';
  values['last_name'] = contact.lastName ?? '';
  if (contact.id !== undefined) values['id'] = contact.id;

  return values;
}

/**
 * Which tags a contact cannot satisfy.
 *
 * Used at launch (docs/04 stage 3: "required merge tags resolvable"). A tag
 * with a default is always resolvable; a required one is not, and a campaign
 * whose subject line has a hole in it should not leave.
 */
export function unresolvableTags(
  tags: readonly MergeTag[],
  values: Readonly<Record<string, string>>,
): MergeTag[] {
  return tags.filter(
    (tag) => tag.required && (values[tag.field] === undefined || values[tag.field] === ''),
  );
}
