import type {
  FileContentResponse,
  HtmlTemplateTag,
  PiWebPlugin,
  SvgTemplateTag,
  WorkspacePanelContext,
  WorkspacePanelHost,
  WorkspaceFiles,
} from "@jmfederico/pi-web/plugin-api";

const HISTORY_PATH = "/home/agent/.pi/scheduled/history.jsonl";
const MAX_LOG_CHARS = 20_000;

// ── data types ───────────────────────────────────────────────────────────────

interface SchedulerRun {
  runId: string;
  task: string;
  status?: "succeeded" | "failed";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  classification?: string;
  stderrTail?: string;
  stdoutPath: string;
  stderrPath: string;
  taskDefinition?: Record<string, unknown>;
}

interface HistoryRecord {
  event: "started" | "completed";
  runId: string;
  task: string;
  startedAt: string;
  stdoutPath: string;
  stderrPath: string;
  taskDefinition?: Record<string, unknown>;
  status?: "succeeded" | "failed";
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  classification?: string;
  stderrTail?: string;
}

// ── parsing helpers ───────────────────────────────────────────────────────────

function parseHistory(content: string): SchedulerRun[] {
  const latestByRun = new Map<string, SchedulerRun>();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record: HistoryRecord = JSON.parse(line);
      if (record.runId) {
        if (record.event === "completed") {
          latestByRun.set(record.runId, {
            runId: record.runId,
            task: record.task,
            status: record.status,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt,
            durationMs: record.durationMs,
            exitCode: record.exitCode,
            classification: record.classification,
            stderrTail: record.stderrTail,
            stdoutPath: record.stdoutPath,
            stderrPath: record.stderrPath,
            taskDefinition: record.taskDefinition,
          });
        } else if (!latestByRun.has(record.runId)) {
          // Only set the "started" record if we don't already have a completed one
          latestByRun.set(record.runId, {
            runId: record.runId,
            task: record.task,
            status: undefined,
            startedAt: record.startedAt,
            stdoutPath: record.stdoutPath,
            stderrPath: record.stderrPath,
            taskDefinition: record.taskDefinition,
          });
        }
      }
    } catch {
      // A crash during append can leave one partial line; retain valid history.
    }
  }
  return [...latestByRun.values()].sort((a, b) =>
    String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")),
  );
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return "running";
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>\"]/g, (char) => HTML_ESCAPE_MAP[char] ?? char);

// ── custom element ───────────────────────────────────────────────────────────

class SchedulerHistoryView extends HTMLElement {
  private _files?: WorkspaceFiles;
  private _running = false;
  private _haveResult = false;
  private _runs: SchedulerRun[] = [];
  private _error?: string;
  private _selected?: SchedulerRun;
  private _stdout?: string;
  private _stderr?: string;
  private _logError?: string;

  set files(value: WorkspaceFiles) {
    this._files = value;
    this.load(false);
  }

  private async load(forceRefresh: boolean): Promise<void> {
    if (!this._files) return;
    if (this._running) return;
    if (!forceRefresh && this._haveResult) return;
    this._running = true;
    this.render();
    try {
      const file: FileContentResponse = await this._files.readFile(HISTORY_PATH);
      this._runs = file.binary ? [] : parseHistory(file.content);
      this._error = undefined;
    } catch (error) {
      this._runs = [];
      this._error = error instanceof Error ? error.message : String(error);
    } finally {
      this._running = false;
      this._haveResult = true;
      this.render();
    }
  }

  private async showRun(run: SchedulerRun): Promise<void> {
    this._selected = run;
    this._logError = undefined;
    this.render();
    try {
      const [stdout, stderr] = await Promise.all([
        this._files!.readFile(run.stdoutPath),
        this._files!.readFile(run.stderrPath),
      ]);
      this._stdout = stdout.binary ? "Binary stdout omitted." : stdout.content.slice(-MAX_LOG_CHARS);
      this._stderr = stderr.binary ? "Binary stderr omitted." : stderr.content.slice(-MAX_LOG_CHARS);
    } catch (error) {
      this._logError = error instanceof Error ? error.message : String(error);
      this._stdout = "";
      this._stderr = "";
    }
    this.render();
  }

  private render(): void {
    const runs = this._runs;
    const selected = this._selected;
    const loading = this._running;
    const error = this._error;

    const rows = runs
      .map((run) => {
        const statusClass = escapeHtml(run.status ?? "running");
        const statusText = escapeHtml(run.status ?? "running");
        return `<button class="run ${statusClass}" data-run="${escapeHtml(run.runId)}">
      <strong>${escapeHtml(run.task)}</strong><span>${statusText}</span>
      <small>${escapeHtml(run.startedAt)} · ${escapeHtml(formatDuration(run.durationMs))}${run.exitCode !== undefined ? ` · exit ${escapeHtml(run.exitCode)}` : ""}</small>
    </button>`;
      })
      .join("");

    const detail = selected
      ? `<section class="detail"><h3>${escapeHtml(selected.task)} <small>${escapeHtml(selected.status)}</small></h3>
      <p>Run: <code>${escapeHtml(selected.runId)}</code><br>Duration: ${escapeHtml(formatDuration(selected.durationMs))}${selected.classification ? `<br>Classification: ${escapeHtml(selected.classification)}` : ""}</p>
      ${this._logError ? `<p class="error">${escapeHtml(this._logError)}</p>` : ""}
      <h4>stderr</h4><pre>${escapeHtml(this._stderr ?? selected.stderrTail ?? "Loading…")}</pre>
      <h4>stdout</h4><pre>${escapeHtml(this._stdout ?? "Loading…")}</pre>
    </section>`
      : "";

    this.innerHTML = `<style>
      :host { display:block; padding: 12px; color: var(--text, inherit); } .toolbar { display:flex; justify-content:space-between; gap:8px; align-items:center; }
      button { font:inherit; cursor:pointer; } .run { width:100%; text-align:left; display:grid; grid-template-columns:1fr auto; gap:3px 12px; padding:9px; border:1px solid color-mix(in srgb, currentColor 18%, transparent); background:transparent; color:inherit; border-radius:6px; margin:6px 0; }
      .run small { grid-column:1 / -1; opacity:.7; } .run.failed span, .error { color:#e05252; } .run.succeeded span { color:#35a96b; } .detail { margin-top:14px; } pre { max-height:280px; overflow:auto; white-space:pre-wrap; background:color-mix(in srgb, currentColor 7%, transparent); padding:10px; border-radius:6px; } code { word-break:break-all; }
    </style><section class="toolbar"><strong>Scheduled runs</strong><button id="refresh">Refresh</button></section>
    ${loading ? "<p>Loading scheduler history…</p>" : ""}
    ${error ? `<p class="error">${escapeHtml(error)}</p><p class="muted">No scheduler history exists yet. Run a scheduled task first.</p>` : ""}
    ${!loading && !error && runs.length === 0 ? "<p class=\"muted\">No scheduled executions yet.</p>" : ""}
    <section>${rows}</section>${detail}`;

    // Re-attach event listeners
    this.querySelector("#refresh")?.addEventListener("click", () => this.load(true));
    this.querySelectorAll<HTMLElement>("[data-run]").forEach((button) =>
      button.addEventListener("click", () => {
        const run = runs.find((item) => item.runId === button.dataset.run);
        if (run) void this.showRun(run);
      }),
    );
  }
}

if (!customElements.get("scheduler-history-view")) {
  customElements.define("scheduler-history-view", SchedulerHistoryView);
}

// ── plugin definition ────────────────────────────────────────────────────────

const plugin: PiWebPlugin = {
  apiVersion: 1,
  name: "Scheduler History",
  activate: ({ html, svg }: { html: HtmlTemplateTag; svg: SvgTemplateTag }) => ({
    contributions: {
      workspacePanels: [
        {
          id: "history",
          title: "Scheduled runs",
          icon: svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>`,
          order: 95,
          render: ({ files, host }: WorkspacePanelContext) =>
            html`<scheduler-history-view .files=${files} .host=${host}></scheduler-history-view>`,
        },
      ],
    },
  }),
};

export default plugin;
