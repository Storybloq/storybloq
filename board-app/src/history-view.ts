import type { History, HandoverRow, HistoryGroup } from "./history.js";
import {
  markdown,
  repairMessage,
  ViewError,
  viewMessage,
  textElement,
  type Call,
} from "./view-utils.js";

const dateLabel = (date: string | null) =>
  date
    ? new Date(date + "T00:00:00Z").toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : "Unknown date";

type Day = { group: HistoryGroup; button: HTMLButtonElement; offset: number };
type Page = {
  items: HandoverRow[];
  offset: number;
  limit: number;
  total: number;
};

export function mountHistory(d: Document, call: Call) {
  const el = (id: string) => d.getElementById(id)!;
  let active = false,
    disposed = false,
    ready = false,
    busy = false,
    generation = 0,
    detailGeneration = 0,
    offset = 0;
  let selected: Day | undefined;
  const lostFocus = (previous: HTMLElement) =>
    !previous.isConnected &&
    (d.activeElement === d.body || d.activeElement === previous);
  function revealInspector() {
    if (d.activeElement === el("history-detail-title"))
      el("history-detail").scrollIntoView?.({ block: "nearest" });
  }
  function close(restore = false) {
    detailGeneration++;
    el("history-detail").hidden = true;
    el("history-layout").classList.remove("detail-open");
    el("history-detail-body").replaceChildren();
    selected?.button.setAttribute("aria-pressed", "false");
    if (restore && selected?.button.isConnected) selected.button.focus();
    selected = undefined;
  }
  function begin(day: Day, title: string, focus: boolean) {
    selected?.button.setAttribute("aria-pressed", "false");
    selected = day;
    day.button.setAttribute("aria-pressed", "true");
    const current = ++detailGeneration,
      board = generation;
    el("history-detail").hidden = false;
    el("history-layout").classList.add("detail-open");
    el("history-detail-title").textContent = title;
    if (focus) el("history-detail-title").focus();
    return () =>
      active &&
      !disposed &&
      current === detailGeneration &&
      board === generation;
  }
  async function detail(row: HandoverRow, day: Day, fromList = false) {
    if (!active || disposed || busy || !day.button.isConnected) return;
    const valid = begin(day, row.title, true),
      body = el("history-detail-body"),
      content = textElement(d, "div", "Loading handover…");
    body.replaceChildren();
    if (fromList) {
      const back = textElement(d, "button", "Back to day", "history-back");
      back.type = "button";
      back.onclick = () => {
        if (valid()) void openDay(day);
      };
      body.append(back);
    }
    body.append(content);
    try {
      const r = await call("storybloq_handover_detail", { id: row.key });
      if (!valid()) return;
      if (r.isError) throw new ViewError(repairMessage(r));
      const h = r._meta?.handover;
      if (!h)
        throw new ViewError(
          "Handover could not load. Close and select it again.",
        );
      content.replaceChildren(markdown(d, h.content));
      if (h.truncated)
        content.append(
          textElement(
            d,
            "p",
            "This handover preview was shortened. The full text remains in your project.",
            "muted",
          ),
        );
      revealInspector();
      el("history-status").textContent = "Handover loaded: " + row.title;
    } catch (e) {
      if (valid()) {
        content.textContent = viewMessage(
          e,
          "Handover could not load. Close and select it again.",
        );
        revealInspector();
        el("history-status").textContent =
          "Handover could not load. Close and select it again.";
      }
    }
  }
  async function openDay(day: Day, focus = true) {
    if (!active || disposed || busy || !day.button.isConnected) return;
    const previous = d.activeElement as HTMLElement,
      valid = begin(day, dateLabel(day.group.date), focus),
      body = el("history-detail-body");
    body.textContent = "Loading handovers…";
    try {
      const r = await call("storybloq_timeline_group", {
        group: day.group.key,
        phase: "all",
        offset: day.offset,
        limit: 10,
      });
      if (!valid()) return;
      if (r.isError) throw new ViewError(repairMessage(r));
      const page: Page = r._meta?.handovers;
      if (!Array.isArray(page?.items))
        throw new ViewError("Date group could not load.");
      day.offset = page.offset;
      body.replaceChildren(
        textElement(
          d,
          "p",
          `${page.total} handover${page.total === 1 ? "" : "s"}`,
          "muted history-day-count",
        ),
      );
      for (const row of page.items) {
        const b = textElement(d, "button", "", "handover-row"),
          icon = textElement(d, "span", "", "handover-document"),
          arrow = textElement(d, "span", "›", "handover-chevron");
        b.type = "button";
        icon.setAttribute("aria-hidden", "true");
        arrow.setAttribute("aria-hidden", "true");
        b.append(
          icon,
          textElement(d, "span", row.title, "handover-title"),
          arrow,
        );
        b.onclick = () => {
          if (valid()) void detail(row, day, true);
        };
        body.append(b);
      }
      if (!page.total)
        body.append(
          textElement(
            d,
            "p",
            "No handovers remain for this date. Refresh the timeline.",
            "empty",
          ),
        );
      const pager = textElement(d, "div", "", "pager"),
        prev = textElement(d, "button", "Prev", "group-previous"),
        next = textElement(d, "button", "Next", "group-next");
      prev.type = next.type = "button";
      prev.setAttribute(
        "aria-label",
        "Previous handovers for " + dateLabel(day.group.date),
      );
      next.setAttribute(
        "aria-label",
        "Next handovers for " + dateLabel(day.group.date),
      );
      prev.disabled = page.offset === 0;
      next.disabled = page.offset + page.limit >= page.total;
      prev.onclick = () => {
        if (valid() && !prev.disabled)
          void openDay(
            { ...day, offset: Math.max(0, page.offset - page.limit) },
            false,
          );
      };
      next.onclick = () => {
        if (valid() && !next.disabled)
          void openDay({ ...day, offset: page.offset + page.limit }, false);
      };
      pager.append(
        prev,
        textElement(
          d,
          "span",
          page.total
            ? `${page.offset + 1}-${page.offset + page.items.length} of ${page.total}`
            : "0 handovers",
          "position",
        ),
        next,
      );
      body.append(pager);
      if (!focus && lostFocus(previous)) {
        const preferred = previous.classList.contains("group-next")
          ? next
          : prev;
        (previous.classList.contains("group-retry")
          ? (body.querySelector<HTMLButtonElement>(".handover-row") ??
            el("history-detail-title"))
          : !preferred.disabled
            ? preferred
            : !prev.disabled
              ? prev
              : !next.disabled
                ? next
                : el("history-detail-title")
        ).focus();
      }
      revealInspector();
      el("history-status").textContent =
        "Handovers loaded for " + dateLabel(day.group.date);
    } catch (error) {
      if (!valid()) return;
      body.replaceChildren(
        textElement(d, "p", viewMessage(error, "Date group could not load.")),
      );
      const retry = textElement(d, "button", "Try again", "group-retry");
      retry.type = "button";
      retry.onclick = () => {
        if (valid()) void openDay(day, false);
      };
      body.append(retry);
      el("history-status").textContent =
        "Date group could not load. Try again.";
      if (!focus && lostFocus(previous)) retry.focus();
      revealInspector();
    }
  }
  function dateGroup(g: HistoryGroup, current: number) {
    const button = textElement(d, "button", "", "history-group"),
      marker = textElement(d, "span", "", "history-marker"),
      label = textElement(d, "span", "", "history-label"),
      titles = g.previewTitles ?? [],
      single = g.count === 1;
    button.type = "button";
    button.dataset.group = g.key;
    button.setAttribute("aria-pressed", "false");
    marker.setAttribute("aria-hidden", "true");
    label.append(
      textElement(d, "span", dateLabel(g.date), "history-date"),
      textElement(
        d,
        "span",
        single
          ? (g.singleHandover?.title ?? titles[0] ?? "1 handover")
          : `${g.count} handovers`,
        "history-heading",
      ),
    );
    if (!single && titles.length) {
      label.append(
        textElement(
          d,
          "span",
          titles.slice(0, 3).join(" · "),
          "history-preview",
        ),
      );
      if (g.count > 3)
        label.append(
          textElement(d, "span", `${g.count - 3} more`, "history-more"),
        );
    }
    button.append(marker, label);
    button.onclick = () => {
      if (!active || disposed || busy || current !== generation) return;
      const day = { group: g, button, offset: 0 };
      if (single && g.singleHandover) void detail(g.singleHandover, day);
      else void openDay(day);
    };
    return button;
  }
  function render(h: History, focus: HTMLElement) {
    if (!Array.isArray(h?.groups?.items))
      throw new ViewError("Timeline could not load.");
    offset = h.groups.offset;
    const list = el("history-list");
    list.replaceChildren(
      ...h.groups.items.map((g) => dateGroup(g, generation)),
    );
    if (!h.groups.total)
      list.append(
        textElement(
          d,
          "p",
          "No handovers yet. Your session history will appear here.",
          "empty",
        ),
      );
    (el("history-previous") as HTMLButtonElement).disabled = offset === 0;
    (el("history-next") as HTMLButtonElement).disabled =
      offset + h.groups.limit >= h.groups.total;
    el("history-position").textContent = h.groups.total
      ? `${offset + 1}-${offset + h.groups.items.length} of ${h.groups.total} dates`
      : "0 dates";
    el("history-status").textContent =
      "Updated " + new Date(h.loadedAt).toLocaleTimeString();
    if (
      focus.dataset.group &&
      (d.activeElement === d.body || d.activeElement === focus)
    ) {
      const replacement = [
        ...list.querySelectorAll<HTMLButtonElement>(".history-group"),
      ].find((g) => g.dataset.group === focus.dataset.group);
      (replacement ?? el("refresh")).focus();
    }
    ready = true;
  }
  async function refresh() {
    if (!active || disposed) return;
    const current = ++generation,
      focusBefore = d.activeElement as HTMLElement;
    busy = true;
    close();
    el("history-error").textContent = "";
    el("history-status").textContent = "Loading timeline…";
    el("history-list")
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = true));
    (el("history-previous") as HTMLButtonElement).disabled = true;
    (el("history-next") as HTMLButtonElement).disabled = true;
    try {
      const r = await call("storybloq_timeline", {
        phase: "all",
        offset,
        limit: 10,
      });
      if (!active || disposed || current !== generation) return;
      if (r.isError) throw new ViewError(repairMessage(r));
      render(r._meta?.history, focusBefore);
    } catch (e) {
      if (active && !disposed && current === generation) {
        el("history-error").textContent = viewMessage(
          e,
          "Timeline could not load. Refresh to try again.",
        );
        el("history-status").textContent =
          "Previously displayed data may be out of date. Refresh to try again.";
      }
    } finally {
      if (current === generation) busy = false;
    }
  }
  el("history-close").onclick = () => close(true);
  el("history-detail").onkeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    }
  };
  el("history-previous").onclick = () => {
    if (busy || (el("history-previous") as HTMLButtonElement).disabled) return;
    offset = Math.max(0, offset - 10);
    void refresh();
  };
  el("history-next").onclick = () => {
    if (busy || (el("history-next") as HTMLButtonElement).disabled) return;
    offset += 10;
    void refresh();
  };
  return {
    refresh,
    autoRefresh() {
      if (ready && !busy && el("history-detail").hidden) void refresh();
    },
    setActive(value: boolean) {
      active = value;
      generation++;
      busy = false;
      close();
    },
    dispose() {
      disposed = true;
      active = false;
      generation++;
      close();
    },
  };
}
