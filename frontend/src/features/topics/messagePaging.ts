// Paging model for the messages view: cursor = a window anchored either at
// the log's ends ("head" = oldest page, "tail" = newest page) or at an
// explicit offset. 最早/最新 are one-shot teleports of this window, NOT sort
// modes — rows always render offset-ascending. prev/next move the window
// older/newer along the offset axis.
import type { GoToTarget } from "./GoToDialog.js";

export type PagingCursor = "head" | "tail" | { offset: number };

export interface BrowseReqArgs {
  connectionId: string;
  topic: string;
  partition: number;
  pageSize: number;
  decodeOn: boolean;
  cursor: PagingCursor;
  goto?: GoToTarget;
}

// buildBrowseReq shapes the backend BrowseRequest for one page window.
// tail = newest window (backward from the end); head and explicit offsets
// page forward from the log start / the cursor.
export function buildBrowseReq(a: BrowseReqArgs): Record<string, unknown> {
  const c = a.cursor;
  const req: Record<string, unknown> = {
    connectionId: a.connectionId,
    topic: a.topic,
    partition: a.partition,
    direction: c === "tail" ? "backward" : "forward",
    limit: a.pageSize,
    decode: a.decodeOn ? "auto" : undefined,
  };
  if (a.goto) {
    req.partition = a.goto.partition;
    if (a.goto.offset !== undefined) req.startOffset = a.goto.offset;
    if (a.goto.timestamp !== undefined) req.startTimestamp = a.goto.timestamp;
  } else if (typeof c === "object") {
    req.startOffset = c.offset;
  }
  return req;
}

// prevCursor steps one window toward older records (window start - size).
export function prevCursor(firstOffset: number, pageSize: number): PagingCursor {
  return { offset: firstOffset - pageSize };
}

// nextCursor steps one window toward newer records (window end + 1).
export function nextCursor(lastOffset: number): PagingCursor {
  return { offset: lastOffset + 1 };
}

// buildFindReq shapes the search request (same window semantics: forward
// from the log start, capped by the scan budget).
export function buildFindReq(a: {
  connectionId: string;
  topic: string;
  partition: number;
  pageSize: number;
  pattern: string;
  regex: boolean;
  maxScan: number;
}): Record<string, unknown> {
  return {
    connectionId: a.connectionId,
    topic: a.topic,
    partition: a.partition,
    direction: "forward",
    limit: a.pageSize,
    pattern: a.pattern,
    regex: a.regex,
    matchKey: true,
    matchValue: true,
    maxScan: a.maxScan,
  };
}
