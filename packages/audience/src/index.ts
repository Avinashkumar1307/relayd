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
export {
  parseDelimited,
  detectDelimiter,
  normaliseHeader,
  CsvParseError,
} from './import/csv-parser.js';
export type { ParsedRow, ParseOptions } from './import/csv-parser.js';
export { runImport, importRows, isPlausibleEmail } from './import/pipeline.js';
export type {
  ImportSink,
  ImportOptions,
  ImportSummary,
  ImportCallbacks,
  NormalisedContact,
  RowFailure,
  BatchResult,
} from './import/pipeline.js';
export {
  readXlsxRows,
  hasZipMagic,
  columnIndex,
  excelSerialToIso,
  XlsxError,
} from './import/xlsx-reader.js';
export type { XlsxOptions } from './import/xlsx-reader.js';
export { runContactImport } from './import/consumer.js';
export type {
  ContactImportJob,
  ContactImportDeps,
  ImportFileSource,
  ImportFileType,
  ImportJobStore,
  ImportOutcome,
} from './import/consumer.js';
export { localFileSource, spoolingSource } from './import/sources.js';
