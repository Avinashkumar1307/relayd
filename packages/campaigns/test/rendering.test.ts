import { describe, expect, it } from 'vitest';
import {
  contactValues,
  discoverMergeTags,
  escapeHtml,
  renderMergeTags,
  unresolvableTags,
} from '../src/templates/merge-tags.js';
import { compileTemplate, htmlToText, renderTemplate } from '../src/templates/render.js';

/**
 * Merge tags and rendering.
 *
 * The Phase 4 gate names one of these directly: "a missing merge field renders
 * its default". The others are the ones that turn into visible campaign
 * failures — a token in a subject line, a name that breaks an attribute, a
 * text part that differs from the HTML.
 */

describe('discovering merge tags', () => {
  it('finds tags across every part a recipient sees', () => {
    // A tag used only in the subject still has to be checked at launch.
    const tags = discoverMergeTags('Hi {{ first_name }}', '', '<p>{{ company }}</p>', '{{ city }}');

    expect(tags.map((tag) => tag.field).sort()).toEqual(['city', 'company', 'first_name']);
  });

  it('records the default and whether one was given', () => {
    const [withDefault, without] = discoverMergeTags('{{ first_name | there }} {{ company }}');

    expect(withDefault).toEqual({ field: 'first_name', default: 'there', required: false });
    expect(without).toEqual({ field: 'company', default: '', required: true });
  });

  it('tolerates the whitespace authors actually write', () => {
    const tags = discoverMergeTags('{{first_name}} {{ last_name }} {{  city  |  London  }}');

    expect(tags.map((tag) => tag.field)).toEqual(['first_name', 'last_name', 'city']);
    expect(tags[2]?.default).toBe('London');
  });

  it('takes the first default when a field appears twice', () => {
    // Rendering has to pick one, and the same field rendering differently in
    // the subject and the body is worse than an arbitrary choice.
    const tags = discoverMergeTags('{{ name | A }} and {{ name | B }}');

    expect(tags).toHaveLength(1);
    expect(tags[0]?.default).toBe('A');
  });

  it('ignores anything that is not a field name', () => {
    // A template language with paths in it is one that can be pointed
    // somewhere it should not go.
    expect(discoverMergeTags('{{ ../../etc/passwd }}')).toEqual([]);
    expect(discoverMergeTags('{{ 1 + 1 }}')).toEqual([]);
    expect(discoverMergeTags('{{ }}')).toEqual([]);
    expect(discoverMergeTags('{ not_a_tag }')).toEqual([]);
  });

  it('is case-insensitive about the field', () => {
    const tags = discoverMergeTags('{{ First_Name }} {{ first_name }}');
    expect(tags).toHaveLength(1);
    expect(tags[0]?.field).toBe('first_name');
  });
});

describe('rendering merge tags', () => {
  const values = { first_name: 'Aisha', email: 'aisha@example.com', city: '' };

  it('substitutes a value the contact has', () => {
    expect(renderMergeTags('Hi {{ first_name }}', { values })).toBe('Hi Aisha');
  });

  it('renders the default when the field is missing', () => {
    // The gate criterion. "Hi {{ first_name }}" arriving in an inbox is the
    // single most visible way a campaign goes wrong.
    expect(renderMergeTags('Hi {{ company | friend }}', { values })).toBe('Hi friend');
  });

  it('renders the default when the field is present but empty', () => {
    // An imported CSV with a blank column is the common case, and it is not
    // meaningfully different from the field being absent.
    expect(renderMergeTags('From {{ city | somewhere }}', { values })).toBe('From somewhere');
  });

  it('never renders the literal token', () => {
    expect(renderMergeTags('Hi {{ unknown_field }}', { values })).toBe('Hi ');
    expect(renderMergeTags('Hi {{ unknown_field }}', { values })).not.toContain('{{');
  });

  it('falls back to the version default when the tag has none', () => {
    const rendered = renderMergeTags('Hi {{ company }}', {
      values,
      defaults: { company: 'your company' },
    });

    expect(rendered).toBe('Hi your company');
  });

  it('prefers the tag default over the version default', () => {
    const rendered = renderMergeTags('Hi {{ company | friend }}', {
      values,
      defaults: { company: 'your company' },
    });

    expect(rendered).toBe('Hi friend');
  });

  it('escapes a value for HTML', () => {
    // A contact's name is attacker-controlled: anyone can put anything in a
    // signup form.
    const rendered = renderMergeTags('<p>Hi {{ first_name }}</p>', {
      values: { first_name: '<script>alert(1)</script>' },
    });

    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;');
  });

  it('escapes quotes, because tags appear inside attributes', () => {
    // <a href="/u/{{ token }}"> is a real thing authors write.
    const rendered = renderMergeTags('<a title="{{ name }}">x</a>', {
      values: { name: '" onmouseover="alert(1)' },
    });

    expect(rendered).not.toContain('onmouseover="');
    expect(rendered).toContain('&quot;');
  });

  it('does not escape in text mode', () => {
    // A text part that says "Ben &amp; Jerry's" is a bug customers notice.
    expect(renderMergeTags('Hi {{ name }}', { values: { name: "Ben & Jerry's" } }, 'text')).toBe(
      "Hi Ben & Jerry's",
    );
  });
});

describe('flattening a contact', () => {
  it('exposes the contact fields and its attributes', () => {
    const values = contactValues({
      id: 'c1',
      email: 'aisha@example.com',
      firstName: 'Aisha',
      lastName: 'Khan',
      attributes: { company: 'Acme', plan: 'pro', seats: 12 },
    });

    expect(values).toMatchObject({
      email: 'aisha@example.com',
      first_name: 'Aisha',
      last_name: 'Khan',
      company: 'Acme',
      seats: '12',
    });
  });

  it('does not let an attribute shadow the contact fields', () => {
    // An imported CSV column called "email" must not change who an
    // unsubscribe link belongs to.
    const values = contactValues({
      email: 'real@example.com',
      attributes: { email: 'attacker@evil.test', first_name: 'Someone Else' },
    });

    expect(values['email']).toBe('real@example.com');
    expect(values['first_name']).toBe('');
  });

  it('renders a missing name as empty rather than "null"', () => {
    const values = contactValues({ email: 'a@example.com', firstName: null, lastName: null });

    expect(values['first_name']).toBe('');
    expect(values['last_name']).toBe('');
  });
});

describe('launch-time resolvability', () => {
  it('reports a required tag the contact cannot satisfy', () => {
    // docs/04 stage 3: a campaign whose subject has a hole in it should not
    // leave.
    const tags = discoverMergeTags('{{ first_name | there }} at {{ company }}');
    const missing = unresolvableTags(tags, { first_name: 'Aisha' });

    expect(missing.map((tag) => tag.field)).toEqual(['company']);
  });

  it('treats a tag with a default as always resolvable', () => {
    const tags = discoverMergeTags('{{ company | your company }}');
    expect(unresolvableTags(tags, {})).toEqual([]);
  });
});

describe('compiling a template', () => {
  it('sanitises the HTML and records what it removed', () => {
    const compiled = compileTemplate({
      subject: 'Hello',
      html: '<p>Hi</p><script>alert(1)</script>',
    });

    expect(compiled.htmlCompiled).not.toContain('<script');
    expect(compiled.removed).toContain('<script>');
  });

  it('derives the text part from the sanitised HTML, not the source', () => {
    // A payload stripped from the HTML must not survive in the text part,
    // which several clients render preferentially.
    const compiled = compileTemplate({
      subject: 'Hello',
      html: '<p>Hi there</p><script>alert(1)</script>',
    });

    expect(compiled.textBody).toContain('Hi there');
    expect(compiled.textBody).not.toContain('alert(1)');
  });

  it('keeps an author-supplied text part', () => {
    const compiled = compileTemplate({
      subject: 'Hello',
      html: '<p>Fancy</p>',
      text: 'Plain and deliberate',
    });

    expect(compiled.textBody).toBe('Plain and deliberate');
  });

  it('derives one when the author left it blank', () => {
    const compiled = compileTemplate({ subject: 'Hello', html: '<p>Hi</p>', text: '   ' });
    expect(compiled.textBody).toBe('Hi');
  });

  it('records the variables it found', () => {
    const compiled = compileTemplate({
      subject: 'Hi {{ first_name | there }}',
      html: '<p>Your plan is {{ plan }}</p>',
    });

    expect(compiled.variables.map((v) => v.field).sort()).toEqual(['first_name', 'plan']);
  });
});

describe('rendering a compiled template', () => {
  const compiled = compileTemplate({
    subject: 'Hi {{ first_name | there }}',
    preheader: 'A note for {{ first_name | you }}',
    html: '<p>Hello {{ first_name | there }}, welcome to {{ company | Relayd }}.</p>',
  });

  it('substitutes in the subject, the body and the preheader', () => {
    const rendered = renderTemplate(compiled, { values: { first_name: 'Aisha' } });

    expect(rendered.subject).toBe('Hi Aisha');
    expect(rendered.html).toContain('Hello Aisha');
    expect(rendered.html).toContain('A note for Aisha');
    expect(rendered.text).toContain('Hello Aisha');
  });

  it('does not HTML-escape the subject', () => {
    // A subject is not markup. "Ben &amp; Jerry's" in an inbox is a bug
    // customers notice within the hour.
    const rendered = renderTemplate(compiled, { values: { first_name: "Ben & Jerry's" } });
    expect(rendered.subject).toBe("Hi Ben & Jerry's");
  });

  it('escapes a hostile value in the body', () => {
    const rendered = renderTemplate(compiled, {
      values: { first_name: '<img src=x onerror=alert(1)>' },
    });

    // Escaped, so it renders as visible text and cannot fire. The characters
    // survive; the markup does not.
    expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(rendered.html).not.toMatch(/<img[^>]*onerror/u);
  });

  it('hides the preheader from the visible body', () => {
    const rendered = renderTemplate(compiled, { values: { first_name: 'Aisha' } });
    expect(rendered.html).toMatch(/display:none[^>]*>A note for Aisha/u);
  });

  it('omits the preheader block when there is none', () => {
    const plain = compileTemplate({ subject: 'Hi', html: '<p>Hello</p>' });
    const rendered = renderTemplate(plain, { values: {} });

    expect(rendered.html).not.toContain('display:none');
  });

  it('is deterministic', () => {
    // A campaign records the version it rendered. A report that cannot be
    // reproduced is not evidence.
    const context = { values: { first_name: 'Aisha', company: 'Acme' } };
    const first = renderTemplate(compiled, context);

    for (let i = 0; i < 20; i += 1) {
      expect(renderTemplate(compiled, context)).toEqual(first);
    }
  });

  it('renders the same for two contacts with the same values', () => {
    const a = renderTemplate(compiled, { values: { first_name: 'Sam' } });
    const b = renderTemplate(compiled, { values: { first_name: 'Sam' } });
    expect(a).toEqual(b);
  });
});

describe('deriving plain text', () => {
  it('keeps the words and drops the markup', () => {
    expect(htmlToText('<p>Hello <strong>there</strong></p>')).toBe('Hello there');
  });

  it('turns a link into text and a URL', () => {
    // A plain-text reader cannot click a word.
    expect(htmlToText('<a href="https://example.com/x">See the offer</a>')).toBe(
      'See the offer (https://example.com/x)',
    );
  });

  it('does not repeat a URL that is its own label', () => {
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe(
      'https://example.com',
    );
  });

  it('gives list items a marker', () => {
    expect(htmlToText('<ul><li>One</li><li>Two</li></ul>')).toBe('- One\n- Two');
  });

  it('collapses the whitespace that table layout produces', () => {
    // Email layout is tables, and a naive conversion produces a text part
    // that is mostly blank lines.
    const html = '<table><tr><td><p>One</p></td></tr><tr><td><p>Two</p></td></tr></table>';
    // The cell tab is trimmed off the end of each line, leaving one blank
    // line between rows rather than the dozens a naive conversion produces.
    expect(htmlToText(html)).toBe('One\n\nTwo');
  });

  it('decodes entities without reintroducing markup', () => {
    // &amp; is decoded last: decoding it first turns &amp;lt; into < and puts
    // markup back into the text part.
    expect(htmlToText('<p>Ben &amp; Jerry&#39;s</p>')).toBe("Ben & Jerry's");
    expect(htmlToText('<p>&amp;lt;script&amp;gt;</p>')).toBe('&lt;script&gt;');
  });

  it('leaves merge tags alone', () => {
    expect(htmlToText('<p>Hi {{ first_name | there }}</p>')).toBe('Hi {{ first_name | there }}');
  });

  it('strips script and style even if handed unsanitised input', () => {
    expect(htmlToText('<p>Hi</p><script>alert(1)</script><style>p{}</style>')).toBe('Hi');
  });

  it('produces something for an empty document', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText('<p></p>')).toBe('');
  });
});

describe('escaping', () => {
  it('covers every character that can break out', () => {
    expect(escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('escapes the ampersand first, so nothing is double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
