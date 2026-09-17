import type { NextFunction, Request, Response } from 'express';
import { newRequestId, newTraceId, runWithTrace } from '@relayd/logger';

const REQUEST_ID_HEADER = 'x-request-id';
const TRACE_ID_HEADER = 'x-trace-id';

/**
 * Opens a trace scope for the request, so every log line emitted while
 * handling it carries requestId and traceId without any call site adding them
 * (docs/10, "Observability").
 *
 * An inbound x-request-id is honoured so a caller can correlate across our
 * boundary, and the id is echoed on the response: docs/03 returns requestId in
 * every envelope, and it is the only handle a customer has on a 500.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inboundRequestId = req.get(REQUEST_ID_HEADER);
  const inboundTraceId = req.get(TRACE_ID_HEADER);

  const context = {
    requestId: inboundRequestId ?? newRequestId(),
    traceId: inboundTraceId ?? newTraceId(),
  };

  res.setHeader(REQUEST_ID_HEADER, context.requestId);
  res.setHeader(TRACE_ID_HEADER, context.traceId);

  runWithTrace(context, () => {
    next();
  });
}
