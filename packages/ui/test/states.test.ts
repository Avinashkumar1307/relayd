import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_STATES,
  CONTACT_STATES,
  HEALTH,
  NAV,
  RECIPIENT_STATES,
  TONES,
  stateStyle,
} from '../src/index.js';

/**
 * Parity with the design export (CLAUDE.md section 15).
 *
 * "relayd-ui.js is the single source of truth for tokens, state names,
 * labels and tones — mirror it." A mirror that is checked by eye drifts the
 * first time somebody renames a state in one place. This reads the export and
 * compares, so the UI and the design cannot disagree about what a state is
 * called or what colour it is without a test saying so.
 *
 * The design file is plain ES module text with object literals, so it is
 * parsed by evaluating the literal — no JS engine tricks, just `JSON`-like
 * extraction of `export const X = {...};` blocks.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const designDir = path.resolve(here, '../../../design');

function loadExport(file: string, name: string): Record<string, unknown> {
  const source = readFileSync(path.join(designDir, file), 'utf8');
  const start = source.indexOf(`export const ${name} = `);
  if (start === -1) throw new Error(`${name} not found in ${file}`);

  const open = source.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }

  // The literals use bare keys and single quotes, and reference CSS
  // variables as strings. `new Function` turns the literal into an object.
  return new Function(`return (${source.slice(open, end + 1)});`)() as Record<string, unknown>;
}

function loadNav(): { label: string; items: [string, string][] }[] {
  const source = readFileSync(path.join(designDir, 'Shell.dc.html'), 'utf8');
  const start = source.indexOf('const NAV = ');
  const open = source.indexOf('[', start);
  let depth = 0;
  let end = open;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '[') depth += 1;
    if (source[index] === ']') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  return new Function(`return (${source.slice(open, end + 1)});`)() as {
    label: string;
    items: [string, string][];
  }[];
}

/** Drops fields the UI does not carry (none today) and normalises for comparison. */
function comparable(map: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(map).map(([key, value]) => [key, JSON.parse(JSON.stringify(value)) as unknown]),
  );
}

describe('the design export is there to compare against', () => {
  it('finds relayd-ui.js and Shell.dc.html', () => {
    // The tripwire: every assertion below reads these files, and a moved
    // design/ folder would otherwise make the suite vacuously green.
    expect(() => loadExport('relayd-ui.js', 'TONES')).not.toThrow();
    expect(loadNav().length).toBeGreaterThan(0);
  });
});

describe('state maps mirror relayd-ui.js exactly', () => {
  it('campaign states', () => {
    expect(comparable(CAMPAIGN_STATES)).toEqual(loadExport('relayd-ui.js', 'CAMPAIGN_STATES'));
  });

  it('recipient states', () => {
    expect(comparable(RECIPIENT_STATES)).toEqual(loadExport('relayd-ui.js', 'RECIPIENT_STATES'));
  });

  it('contact states', () => {
    expect(comparable(CONTACT_STATES)).toEqual(loadExport('relayd-ui.js', 'CONTACT_STATES'));
  });

  it('health, which the export writes as tuples', () => {
    const theirs = loadExport('relayd-ui.js', 'HEALTH') as Record<string, [string, string]>;
    const ours = Object.fromEntries(Object.entries(HEALTH).map(([key, value]) => [key, [value.label, value.tone]]));

    expect(ours).toEqual(theirs);
  });

  it('tones', () => {
    expect(comparable(TONES)).toEqual(loadExport('relayd-ui.js', 'TONES'));
  });

  it('carries every campaign state the engine has, including the awkward ones', () => {
    // The two that get dropped when somebody hand-writes a list: the outlined
    // completed_with_errors and the hatched delivery_uncertain. The sheet
    // says "never hidden" about the second.
    expect(CAMPAIGN_STATES.completed_with_errors).toMatchObject({ outline: true, dot: 'warning' });
    expect(RECIPIENT_STATES.delivery_uncertain.tone).toBe('uncertain');
    expect(CAMPAIGN_STATES.held.lock).toBe(true);
  });
});

describe('an unknown state is shown, not hidden', () => {
  it('falls back to the raw key in neutral', () => {
    // relayd-ui.js: `map[key] || { label: key, tone: 'neutral' }`. A state
    // the UI has not heard of is exactly the one somebody needs to see.
    expect(stateStyle(CAMPAIGN_STATES, 'something_new')).toEqual({ label: 'something_new', tone: 'neutral' });
  });
});

describe('the sidebar navigation mirrors Shell.dc.html', () => {
  it('has the same groups, in the same order, with the same labels', () => {
    const theirs = loadNav().map((group) => ({
      label: group.label,
      items: group.items.map(([key, label]) => ({ key, label })),
    }));
    const ours = NAV.map((group) => ({
      label: group.label,
      items: group.items.map((item) => ({ key: item.key, label: item.label })),
    }));

    expect(ours).toEqual(theirs);
  });

  it('gives every item an icon the export defines', () => {
    const source = readFileSync(path.join(designDir, 'Shell.dc.html'), 'utf8');

    for (const group of NAV) {
      for (const item of group.items) {
        expect(source, `${item.key} icon`).toContain(`${item.icon}: '`);
      }
    }
  });
});
