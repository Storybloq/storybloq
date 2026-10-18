import {
  columns,
  initialQuery,
  type Overview,
  type Card,
  type Column,
} from "./board-types.js";
import { mountEditor } from "./editor-view.js";
type Result = { isError?: boolean; _meta?: Record<string, any> };
type Call = (name: string, args: Record<string, unknown>) => Promise<Result>;
export function mountBoard(
  d: Document,
  call: Call,
  onRender?: (board: Overview) => void,
) {
  const el = (id: string) => d.getElementById(id)!;
  const text = (id: string, value: string) => {
    el(id).textContent = value;
  };
  let query = { ...initialQuery },
    generation = 0,
    detailGeneration = 0;
  let active = true;
  let busy = false,
    ready = false,
    disposed = false;
  let source: HTMLButtonElement | undefined;
  let selectedKey: string | undefined;
  const editor = mountEditor(d, call, () => void refresh(true));
  const signatures = new Map<string, string>();
  const media = d.defaultView?.matchMedia?.("(max-width: 700px)");
  function arrangeColumns() {
    if (disposed) return;
    const focus = d.activeElement as HTMLElement;
    const order = media?.matches ? ["inProgress", "open", "done"] : columns;
    d.querySelector(".board")!.replaceChildren(
      ...order.map((c) => el(`${c}-column`)),
    );
    if (focus.isConnected && d.activeElement === d.body && focus !== d.body)
      focus.focus();
  }
  arrangeColumns();
  media?.addEventListener("change", arrangeColumns);
  function clearDetail(restore = false) {
    editor.reset();
    detailGeneration++;
    el("detail").hidden = true;
    el("board-layout").classList.remove("detail-open");
    source?.setAttribute("aria-pressed", "false");
    if (restore) {
      if (source?.isConnected && !source.disabled) source.focus();
      else if (query.phase !== "all")
        (
          d.querySelector<HTMLElement>('.phase-step[aria-pressed="true"]') ??
          el("project")
        ).focus();
      else el("project").focus();
    }
    source = undefined;
    selectedKey = undefined;
  }
  function repairMessage(result?: Result) {
    const info = result?._meta?.boardError;
    return info?.code === "storybloq_board_error" &&
      typeof info.message === "string" &&
      info.message.length <= 500
      ? info.message
      : "Check the local project connection.";
  }
  function disableRows() {
    for (const button of d.querySelectorAll<HTMLButtonElement>(
      ".item, .pager button",
    ))
      button.disabled = true;
  }
  function error(result?: Result) {
    disableRows();
    text("status", "The board could not load. Refresh to try again.");
    text(
      "error",
      repairMessage(result) + " Previously displayed data may be out of date.",
    );
  }
  function row(item: Card, column: Column): HTMLLIElement {
    const li = d.createElement("li"),
      button = d.createElement("button"),
      meta = d.createElement("span"),
      title = d.createElement("span");
    const heading = d.createElement("span"),
      description = d.createElement("span"),
      tags = d.createElement("span");
    const signature = `${column}:${item.blocked}`;
    if (signatures.has(item.key) && signatures.get(item.key) !== signature)
      button.classList.add("changed");
    signatures.set(item.key, signature);
    button.classList.add("item");
    button.type = "button";
    button.dataset.key = item.key;
    meta.className = "meta";
    meta.textContent = item.displayId;
    button.setAttribute("aria-pressed", "false");
    if (item.blocked) button.classList.add("blocked");
    if (item.severity) button.dataset.severity = item.severity;
    title.className = "title";
    title.textContent = item.title;
    heading.className = "card-heading";
    heading.append(title, meta);
    description.className = "description";
    description.textContent = item.description;
    tags.className = "tags";
    for (const label of item.tags) {
      const tag = d.createElement("span");
      tag.className = "tag";
      if (label === "Blocked" || label.toLowerCase() === item.severity)
        tag.classList.add("attention");
      tag.textContent = label;
      tags.append(tag);
    }
    button.append(heading, description, tags);
    const current = generation;
    button.onclick = () => {
      if (!disposed && current === generation && !busy)
        editor.guard(() => void showDetail(item, button));
    };
    li.append(button);
    return li;
  }
  function renderSummary(board: Overview) {
    text("project", board.project);
    text(
      "phase",
      board.currentPhase
        ? `${board.currentPhase.name} · ${board.currentPhase.status === "inprogress" ? "In progress" : "Not started"}`
        : board.phases.length &&
            board.phases.every((p) => p.status === "complete")
          ? "All phases complete"
          : "No phase in progress",
    );
    text(
      "progress",
      `${board.summary.complete} / ${board.summary.total} tickets complete${board.summary.blocked ? " · " + board.summary.blocked + " blocked" : ""}`,
    );
    text("error", "");
    const total = columns.reduce((n, c) => n + board.columns[c].total, 0);
    text(
      "status",
      `${total} matching items · Updated ${new Date(board.loadedAt).toLocaleTimeString()}`,
    );
    el("severity").replaceChildren();
    for (const severity of ["critical", "high", "medium", "low"]) {
      const span = d.createElement("span");
      span.className = `severity ${severity}`;
      span.textContent = `${board.summary.severity[severity] ?? 0} ${severity}`;
      el("severity").append(span);
    }
    text(
      "issue-count",
      `${board.summary.openIssues} unresolved issues · Whole project`,
    );
  }
  function renderPhases(board: Overview) {
    const phases = [
      ...board.phases,
      // An active Unphased filter stays visible so it can still be cleared.
      ...(board.hasUnphased || query.phase === "unphased"
        ? [
            {
              key: "unphased",
              name: "Unphased",
              label: "",
              status: "notstarted",
              current: false,
            },
          ]
        : []),
    ];
    el("phase-rail").replaceChildren(
      ...phases.map((p) => {
        const button = d.createElement("button");
        button.type = "button";
        button.className = "phase-step";
        button.dataset.phase = p.key;
        button.dataset.status = p.status;
        button.setAttribute("aria-pressed", String(query.phase === p.key));
        button.setAttribute(
          "aria-label",
          `${p.name}${p.key === "unphased" ? "" : ", " + (p.current ? "Current phase" : ({ complete: "Completed", inprogress: "In progress", notstarted: "Not started" }[p.status] ?? p.status))}`,
        );
        if (p.current) button.setAttribute("aria-current", "step");
        const dot = d.createElement("span"),
          label = d.createElement("span"),
          name = d.createElement("span");
        dot.className = "phase-dot";
        dot.textContent = p.status === "complete" ? "✓" : "";
        dot.setAttribute("aria-hidden", "true");
        label.className = "phase-label";
        label.textContent = p.label;
        name.className = "phase-name";
        name.textContent = p.name;
        button.append(dot, label, name);
        button.onclick = () => {
          if (disposed) return;
          editor.guard(() => {
            clearDetail();
            query = {
              ...initialQuery,
              kind: query.kind,
              query: query.query,
              phase: query.phase === p.key ? "all" : p.key,
            };
            void refresh();
          });
        };
        return button;
      }),
    );
  }
  function renderColumn(
    column: Column,
    page: Overview["columns"][Column],
    limit: number,
  ) {
    query[column] = page.offset;
    text(`${column}-count`, String(page.total));
    const list = el(`${column}-items`);
    list.replaceChildren(...page.items.map((i) => row(i, column)));
    if (!page.items.length) {
      const li = d.createElement("li");
      li.className = "empty";
      li.textContent =
        query.query || query.kind !== "all" || query.phase !== "all"
          ? "No matching items"
          : {
              open: "Nothing waiting",
              inProgress: "No work in progress",
              done: "Completed work will appear here",
            }[column];
      list.append(li);
    }
    text(
      `${column}-position`,
      page.total
        ? `${page.offset + 1}-${page.offset + page.items.length} of ${page.total}`
        : "0 items",
    );
    (el(`${column}-previous`) as HTMLButtonElement).disabled =
      page.offset === 0;
    (el(`${column}-next`) as HTMLButtonElement).disabled =
      page.offset + limit >= page.total;
  }
  function restoreBoardFocus(before: HTMLElement) {
    if (before.dataset.phase) {
      const replacement = [
        ...d.querySelectorAll<HTMLButtonElement>(".phase-step"),
      ].find((b) => b.dataset.phase === before.dataset.phase);
      (replacement ?? el("refresh")).focus();
    } else if (before.dataset.key) {
      const replacement = [
        ...d.querySelectorAll<HTMLButtonElement>(".item"),
      ].find((b) => b.dataset.key === before.dataset.key);
      (replacement ?? el("refresh")).focus();
    } else if (before.closest(".pager")) {
      const pager = before.closest(".pager")!;
      const available = [
        ...pager.querySelectorAll<HTMLButtonElement>("button"),
      ].find((b) => !b.disabled);
      if (!(before as HTMLButtonElement).disabled) before.focus();
      else (available ?? el("refresh")).focus();
    }
  }
  function render(board: Overview, focusBeforeLoad?: HTMLElement) {
    if (
      !board ||
      !columns.every((c) => Array.isArray(board.columns?.[c]?.items))
    )
      throw Error("Missing board");
    const restoreFocus =
      focusBeforeLoad &&
      (d.activeElement === d.body || d.activeElement === focusBeforeLoad);
    renderSummary(board);
    renderPhases(board);
    for (const column of columns)
      renderColumn(column, board.columns[column], board.limit);
    if (selectedKey) {
      source = [...d.querySelectorAll<HTMLButtonElement>(".item")].find(
        (b) => b.dataset.key === selectedKey,
      );
      source?.setAttribute("aria-pressed", "true");
    }
    // Only the last visible page participates in change detection, keeping memory bounded.
    const visibleKeys = new Set(
      columns.flatMap((c) => board.columns[c].items.map((i) => i.key)),
    );
    for (const key of signatures.keys())
      if (!visibleKeys.has(key)) signatures.delete(key);
    if (restoreFocus) restoreBoardFocus(focusBeforeLoad);
    onRender?.(board);
    ready = true;
  }
  async function refresh(keepDetail = editor.editing) {
    if (disposed || !active) return;
    const current = ++generation;
    const focusBeforeLoad = d.activeElement as HTMLElement;
    busy = true;
    if (!keepDetail) clearDetail();
    disableRows();
    text("status", "Loading project…");
    text("error", "");
    try {
      const r = await call("storybloq_board_overview", { ...query });
      if (disposed || !active || current !== generation) return;
      if (r.isError) error(r);
      else render(r._meta?.overview, focusBeforeLoad);
    } catch {
      if (!disposed && current === generation) error();
    } finally {
      if (current === generation) busy = false;
    }
  }
  async function showDetail(item: Card, button: HTMLButtonElement) {
    const current = ++detailGeneration,
      boardGeneration = generation;
    source = button;
    selectedKey = item.key;
    editor.select(item);
    for (const b of d.querySelectorAll(".item"))
      b.setAttribute("aria-pressed", String(b === button));
    el("detail").hidden = false;
    el("board-layout").classList.add("detail-open");
    text("detail-title", `${item.displayId}: ${item.title}`);
    text("detail-body", "Loading details…");
    el("detail-title").focus();
    try {
      const r = await call("storybloq_board_detail", {
        kind: item.kind,
        id: item.id,
      });
      if (
        disposed ||
        current !== detailGeneration ||
        boardGeneration !== generation
      )
        return;
      if (r.isError) {
        text("detail-body", repairMessage(r));
        text("error", repairMessage(r));
        return;
      }
      const detail = r._meta?.item;
      if (!detail) throw Error("Missing details");
      text(
        "detail-body",
        detail.description +
          (detail.truncated
            ? "\n\nThis description was shortened for the board."
            : ""),
      );
      text("status", `Details loaded for ${item.displayId}.`);
      editor.ready();
    } catch {
      if (
        !disposed &&
        current === detailGeneration &&
        boardGeneration === generation
      ) {
        text(
          "detail-body",
          "Details could not load. Close and choose the item to try again.",
        );
        text("error", "The selected item could not be loaded.");
      }
    }
  }
  const filter = el("board-filter"),
    filterToggle = el("filter-toggle"),
    filterOptions = el("filter-options");
  function closeFilter(restore = false) {
    filterOptions.hidden = true;
    filterToggle.setAttribute("aria-expanded", "false");
    if (restore) filterToggle.focus();
  }
  filterToggle.onclick = () => {
    if (disposed || !active) return;
    const open = filterOptions.hidden;
    filterOptions.hidden = !open;
    filterToggle.setAttribute("aria-expanded", String(open));
  };
  filter.onkeydown = (e) => {
    if (disposed || !active || filterOptions.hidden || e.key !== "Escape")
      return;
    e.preventDefault();
    e.stopPropagation();
    closeFilter(true);
  };
  function outsideFilter(e: Event) {
    if (!filter.contains(e.target as Node)) closeFilter();
  }
  function leaveFilter(e: FocusEvent) {
    if (!filter.contains(e.relatedTarget as Node | null)) closeFilter();
  }
  d.addEventListener("click", outsideFilter);
  filter.addEventListener("focusout", leaveFilter);
  for (const kind of ["all", "tickets", "issues"] as const)
    el(kind).onclick = () => {
      if (disposed || !active) return;
      closeFilter(true);
      if (query.kind === kind) return;
      editor.guard(() => {
        if (disposed || !active) return;
        clearDetail();
        query = {
          ...initialQuery,
          query: query.query,
          phase: query.phase,
          kind,
        };
        for (const id of ["all", "tickets", "issues"])
          el(id).setAttribute("aria-pressed", String(id === kind));
        text(
          "filter-label",
          kind === "all"
            ? "Filter"
            : "Filter: " + (kind === "tickets" ? "Tickets" : "Issues"),
        );
        filterToggle.dataset.filtered = String(kind !== "all");
        void refresh();
      });
    };
  function search() {
    editor.guard(() => {
      clearDetail();
      query = {
        ...initialQuery,
        kind: query.kind,
        phase: query.phase,
        query: (el("search") as HTMLInputElement).value,
      };
      void refresh();
    });
  }
  el("search-form").onsubmit = (e) => {
    e.preventDefault();
    search();
  };
  el("search").addEventListener("search", search);
  el("refresh").onclick = () => void refresh();
  el("close-detail").onclick = () => editor.guard(() => clearDetail(true));
  el("detail").onkeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      editor.guard(() => clearDetail(true));
    }
  };
  for (const column of columns)
    for (const direction of ["previous", "next"] as const)
      el(`${column}-${direction}`).onclick = () => {
        editor.guard(() => {
          clearDetail();
          query[column] = Math.max(
            0,
            query[column] + (direction === "next" ? query.limit : -query.limit),
          );
          void refresh();
        });
      };
  return {
    receive(r: Result) {
      if (generation || disposed) return;
      try {
        if (r.isError) error(r);
        else render(r._meta?.overview);
      } catch {
        error();
      }
    },
    error,
    refresh,
    guardLeave: editor.guard,
    setActive(value: boolean) {
      active = value;
      closeFilter();
      generation++;
      busy = false;
      clearDetail();
    },
    autoRefresh() {
      if (active && ready && !busy && el("detail").hidden) void refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      editor.dispose();
      closeFilter();
      d.removeEventListener("click", outsideFilter);
      filter.removeEventListener("focusout", leaveFilter);
      media?.removeEventListener("change", arrangeColumns);
      generation++;
      clearDetail();
      disableRows();
    },
  };
}
