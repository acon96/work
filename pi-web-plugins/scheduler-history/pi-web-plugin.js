const HISTORY_PATH = ".pi-web/scheduler/history.jsonl";
const MAX_LOG_CHARS = 20_000;

function parseHistory(content) {
  const latestByRun = new Map();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.runId) latestByRun.set(record.runId, record);
    } catch {
      // A crash during append can leave one partial line; retain valid history.
    }
  }
  return [...latestByRun.values()].sort((a, b) =>
    String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")),
  );
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return "running";
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}

class SchedulerHistoryView extends HTMLElement {
  set files(value) { this._files = value; void this.load(); }
  set host(value) { this._host = value; }

  connectedCallback() { this.render(); }

  async load() {
    if (!this._files) return;
    this._loading = true;
    this.render();
    try {
      const file = await this._files.readFile(HISTORY_PATH);
      this._runs = file.binary ? [] : parseHistory(file.content);
      this._error = undefined;
    } catch (error) {
      this._runs = [];
      this._error = error instanceof Error ? error.message : String(error);
    } finally {
      this._loading = false;
      this.render();
      this._host?.requestRender();
    }
  }

  async showRun(run) {
    this._selected = run;
    this._logError = undefined;
    this.render();
    try {
      const [stdout, stderr] = await Promise.all([
        this._files.readFile(run.stdoutPath),
        this._files.readFile(run.stderrPath),
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

  render() {
    const runs = this._runs ?? [];
    const selected = this._selected;
    const escape = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
    const rows = runs.map((run) => `<button class="run ${escape(run.status)}" data-run="${escape(run.runId)}">
      <strong>${escape(run.task)}</strong><span>${escape(run.status ?? "running")}</span>
      <small>${escape(run.startedAt)} · ${escape(formatDuration(run.durationMs))}${run.exitCode !== undefined ? ` · exit ${escape(run.exitCode)}` : ""}</small>
    </button>`).join("");
    const detail = selected ? `<section class="detail"><h3>${escape(selected.task)} <small>${escape(selected.status)}</small></h3>
      <p>Run: <code>${escape(selected.runId)}</code><br>Duration: ${escape(formatDuration(selected.durationMs))}${selected.classification ? `<br>Classification: ${escape(selected.classification)}` : ""}</p>
      ${this._logError ? `<p class="error">${escape(this._logError)}</p>` : ""}
      <h4>stderr</h4><pre>${escape(this._stderr ?? selected.stderrTail ?? "Loading…")}</pre>
      <h4>stdout</h4><pre>${escape(this._stdout ?? "Loading…")}</pre>
    </section>` : "";
    this.innerHTML = `<style>
      :host { display:block; padding: 12px; color: var(--text, inherit); } .toolbar { display:flex; justify-content:space-between; gap:8px; align-items:center; }
      button { font:inherit; cursor:pointer; } .run { width:100%; text-align:left; display:grid; grid-template-columns:1fr auto; gap:3px 12px; padding:9px; border:1px solid color-mix(in srgb, currentColor 18%, transparent); background:transparent; color:inherit; border-radius:6px; margin:6px 0; }
      .run small { grid-column:1 / -1; opacity:.7; } .run.failed span, .error { color:#e05252; } .run.succeeded span { color:#35a96b; } .detail { margin-top:14px; } pre { max-height:280px; overflow:auto; white-space:pre-wrap; background:color-mix(in srgb, currentColor 7%, transparent); padding:10px; border-radius:6px; } code { word-break:break-all; }
    </style><section class="toolbar"><strong>Scheduled runs</strong><button id="refresh">Refresh</button></section>
    ${this._loading ? "<p>Loading scheduler history…</p>" : ""}
    ${this._error ? `<p class="error">${escape(this._error)}</p><p class="muted">No scheduler history exists yet. Run a scheduled task first.</p>` : ""}
    ${!this._loading && !this._error && runs.length === 0 ? "<p class=\"muted\">No scheduled executions yet.</p>" : ""}
    <section>${rows}</section>${detail}`;
    this.querySelector("#refresh")?.addEventListener("click", () => this.load());
    this.querySelectorAll("[data-run]").forEach((button) => button.addEventListener("click", () => {
      const run = runs.find((item) => item.runId === button.dataset.run);
      if (run) void this.showRun(run);
    }));
  }
}

if (!customElements.get("scheduler-history-view")) customElements.define("scheduler-history-view", SchedulerHistoryView);

export default {
  apiVersion: 1,
  name: "Scheduler History",
  activate: ({ html, svg }) => ({
    contributions: {
      workspacePanels: [{
        id: "history",
        title: "Scheduled runs",
        icon: svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>`,
        order: 95,
        render: ({ files, host }) => html`<scheduler-history-view .files=${files} .host=${host}></scheduler-history-view>`,
      }],
    },
  }),
};