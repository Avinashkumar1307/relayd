// @relayd/audience/browser — the parts that run in a browser.
//
// The package root re-exports the xlsx reader, which needs `node:fs` and a
// zip library, and a bundler asked for the root will try to resolve both and
// fail. Everything here is pure: text in, text out, no platform APIs beyond
// TextDecoder.
//
// The point of sharing these rather than reimplementing them in the web app is
// that the column mapping form must show exactly the columns the importer will
// find — same BOM handling, same quoting rules — and a downloaded error report
// must be neutralised by the same code that neutralises an export.

export {
  parseDelimited,
  detectDelimiter,
  normaliseHeader,
  CsvParseError,
} from './import/csv-parser.js';
export type { ParsedRow, ParseOptions } from './import/csv-parser.js';

export {
  looksLikeFormula,
  neutraliseCell,
  formatCell,
  formatRow,
  toCsvLines,
} from './export/csv.js';

export {
  parseSegmentAst,
  measure,
  segmentNodeSchema,
  SegmentAstError,
  MAX_DEPTH,
  MAX_NODES,
} from './segments/ast.js';
export type { SegmentNode } from './segments/ast.js';

export { isPlausibleEmail } from './import/pipeline.js';
