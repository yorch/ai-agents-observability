// Jira domain constants shared by web queries and dashboards.

// Issue-type names (lowercased) that count as defect work — the single source
// for both the TS Set consumers (ROI bug-share) and SQL IN-lists (quality page).
export const BUG_ISSUE_TYPE_LIST = ['bug', 'defect'] as const;
export const BUG_ISSUE_TYPES: ReadonlySet<string> = new Set(BUG_ISSUE_TYPE_LIST);
