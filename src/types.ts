export interface ExtractedRow {
  cells: string[];
}

export interface ExtractedTable {
  headers: string[];
  rows: ExtractedRow[];
  source: {
    reportId: string;
    reportName: string;
    visualTitle: string;
    method?: "clipboard" | "dom" | "network";
    url: string;
    collectedAt: string;
  };
}

export interface AuditEvent {
  timestamp: string;
  runId: string;
  reportId: string;
  status: "started" | "completed" | "failed" | "dry-run";
  rowCount?: number;
  columnCount?: number;
  contentHash?: string;
  errorCode?: string;
}
