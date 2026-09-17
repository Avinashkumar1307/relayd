// @relayd/audience — contacts, segments, import parsing.
export {
  parseSegmentAst,
  measure,
  segmentNodeSchema,
  SegmentAstError,
  MAX_DEPTH,
  MAX_NODES,
} from './segments/ast.js';
export type { SegmentNode } from './segments/ast.js';
export { compileSegment, compilePreviewCount } from './segments/compile.js';
export type { CompiledSegment } from './segments/compile.js';
export {
  looksLikeFormula,
  neutraliseCell,
  formatCell,
  formatRow,
  toCsvLines,
} from './export/csv.js';
