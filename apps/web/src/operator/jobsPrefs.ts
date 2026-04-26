const STORAGE_KEY = "queuehouse.jobsTable.v1";

export type JobsTablePrefs = {
  queue: string;
  state: string;
  jobName: string;
  jobId: string;
  schedulerId: string;
  from: string;
  to: string;
  minAttempts: string;
  maxAttempts: string;
  limit: string;
  sortKey: "created" | "state" | "queue" | "jobName" | "attempts" | "priority";
  sortDir: "asc" | "desc";
  density: "normal" | "compact";
};

const DEFAULTS: JobsTablePrefs = {
  queue: "",
  state: "",
  jobName: "",
  jobId: "",
  schedulerId: "",
  from: "",
  to: "",
  minAttempts: "",
  maxAttempts: "",
  limit: "50",
  sortKey: "created",
  sortDir: "desc",
  density: "normal",
};

export function loadJobsTablePrefs(): JobsTablePrefs {
  if (typeof window === "undefined") return { ...DEFAULTS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<JobsTablePrefs>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveJobsTablePrefs(prefs: JobsTablePrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
