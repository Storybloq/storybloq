import { layoutFederation } from "./federation-layout.js";
import type { Federation, FederationNode, NodeDetail } from "./federation.js";
import {
  repairMessage,
  textElement,
  ViewError,
  viewMessage,
  type Call,
} from "./view-utils.js";
export function mountFederation(d: Document, call: Call) {
  const el = (id: string) => d.getElementById(id)!;
  let active = false,
    disposed = false,
    busy = false,
    ready = false,
    generation = 0,
    detailGeneration = 0;
  let source: HTMLButtonElement | undefined;
  let federation: Federation | undefined;
  const buttons = new Map<string, HTMLButtonElement>();
  const health = (n: FederationNode) =>
    ({
      green: "Healthy",
      yellow: "Needs attention",
      red: "At risk",
      grey: "Not assessed",
    })[n.health] ?? "Not assessed";
  function highlight(name?: string) {
    const related = new Set(name ? [name] : []);
    for (const edge of federation?.edges ?? [])
      if (edge.from === name || edge.to === name) {
        related.add(edge.from);
        related.add(edge.to);
      }
    for (const [key, b] of buttons)
      b.classList.toggle("is-unrelated", !!name && !related.has(key));
    el("nodes-graph")
      .querySelectorAll<SVGElement>(".federation-edge")
      .forEach((path) => {
        const selected = path.dataset.from === name || path.dataset.to === name;
        path.classList.toggle("is-unrelated", !!name && !selected);
        path.classList.toggle("is-selected", !!name && selected);
      });
  }
  function close(restore = false) {
    detailGeneration++;
    el("node-detail").hidden = true;
    el("nodes-layout").classList.remove("detail-open");
    source?.setAttribute("aria-pressed", "false");
    if (restore && source?.isConnected) source.focus();
    source = undefined;
    highlight();
  }
  function cacheText(n: FederationNode) {
    return (
      `Cached progress · ${n.cacheState}` +
      (n.cache
        ? ` · ${n.cache.completeTickets}/${n.cache.ticketCount} tickets complete · ${n.cache.openIssues} open issues`
        : "")
    );
  }
  function knownRelations(name: string) {
    const edges = federation?.edges ?? [];
    return {
      buildsAfter: edges
        .filter((e) => e.type === "build" && e.to === name)
        .map((e) => e.from),
      requiredBy: edges
        .filter((e) => e.type === "build" && e.from === name)
        .map((e) => e.to),
      runtimeOutgoing: edges.filter(
        (e) => e.type === "runtime" && e.from === name,
      ),
      runtimeIncoming: edges.filter(
        (e) => e.type === "runtime" && e.to === name && e.from !== name,
      ),
    };
  }
  function nodeInfo(
    n: FederationNode,
    relations: Pick<
      NodeDetail,
      "buildsAfter" | "requiredBy" | "runtimeOutgoing" | "runtimeIncoming"
    >,
    board: number,
    selection: number,
  ) {
    const body = el("node-detail-body");
    body.replaceChildren(
      textElement(
        d,
        "p",
        `${n.kind} · ${n.stack || "Stack not specified"}`,
        "muted",
      ),
      textElement(d, "p", n.role, "node-role"),
      textElement(d, "p", n.summary),
      textElement(d, "p", "Health: " + health(n), "muted"),
      textElement(d, "p", cacheText(n), "muted"),
    );
    if (n.cache?.lastHandoverTitle)
      body.append(
        textElement(
          d,
          "p",
          `Last handover: ${n.cache.lastHandoverDate ?? "Date not recorded"} · ${n.cache.lastHandoverTitle}`,
          "muted",
        ),
      );
    function relation(
      name: string,
      label: string,
      via?: string,
      runtime = false,
    ) {
      const row = textElement(
        d,
        "button",
        "",
        "node-relation" + (runtime ? " runtime" : ""),
      );
      row.type = "button";
      row.append(textElement(d, "span", label));
      if (via) row.append(textElement(d, "span", via, "muted"));
      row.disabled = name === n.name || !buttons.has(name);
      row.onclick = () => {
        if (
          active &&
          !disposed &&
          !busy &&
          board === generation &&
          selection === detailGeneration &&
          row.isConnected
        )
          buttons.get(name)?.click();
      };
      return row;
    }
    for (const [heading, names, empty] of [
      ["Builds after", relations.buildsAfter, "No build dependencies"],
      ["Required by", relations.requiredBy, "No dependents"],
    ] as const) {
      body.append(textElement(d, "h3", heading));
      const list = textElement(d, "div", "", "node-relations");
      for (const name of names) list.append(relation(name, name));
      body.append(names.length ? list : textElement(d, "p", empty, "muted"));
    }
    body.append(textElement(d, "h3", "Runtime links"));
    const runtime = [
      ...relations.runtimeOutgoing,
      ...relations.runtimeIncoming.filter((e) => e.from !== n.name),
    ];
    const links = textElement(d, "div", "", "node-relations");
    for (const e of runtime)
      links.append(
        relation(
          e.from === n.name ? e.to : e.from,
          `${e.from} → ${e.to}`,
          e.via,
          true,
        ),
      );
    body.append(
      runtime.length ? links : textElement(d, "p", "No runtime links", "muted"),
    );
    body.append(textElement(d, "h3", "Active work"));
    const work = textElement(d, "div", "Loading node work…");
    body.append(work);
    return work;
  }
  async function detail(
    n: FederationNode,
    button: HTMLButtonElement,
    offset = 0,
    focus = true,
  ) {
    if (!active || disposed) return;
    const focusBefore = d.activeElement as HTMLElement;
    if (focus) close();
    source = button;
    button.setAttribute("aria-pressed", "true");
    const current = ++detailGeneration,
      board = generation;
    el("node-detail").hidden = false;
    el("nodes-layout").classList.add("detail-open");
    el("node-detail-title").textContent = n.name;
    highlight(n.name);
    let work = nodeInfo(n, knownRelations(n.name), board, current);
    if (focus) {
      // Opening the inspector narrows the map after the original click.
      button.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      el("node-detail-title").focus();
    }
    try {
      const r = await call("storybloq_node_detail", {
        name: n.name,
        offset,
        limit: 10,
      });
      if (
        !active ||
        disposed ||
        current !== detailGeneration ||
        board !== generation
      )
        return;
      if (r.isError) throw new ViewError(repairMessage(r));
      const node = r._meta?.node as NodeDetail;
      if (!node?.preview)
        throw new ViewError(
          "Node details could not load. Close and select it again.",
        );
      work = nodeInfo(node, node, board, current);
      work.replaceChildren();
      const p = node.preview;
      if (p.state !== "ready")
        work.append(
          textElement(d, "p", p.message ?? "Node work is unavailable."),
        );
      else {
        if (!p.total)
          work.append(textElement(d, "p", "No active leaf tickets."));
        for (const t of p.items)
          work.append(
            textElement(
              d,
              "p",
              `${t.displayId} · ${t.title} · ${t.status === "inprogress" ? "In progress" : "Open"}`,
              "active-ticket",
            ),
          );
        const pager = d.createElement("div");
        pager.className = "pager";
        const prev = textElement(d, "button", "Prev"),
          next = textElement(d, "button", "Next");
        prev.type = next.type = "button";
        prev.id = "node-preview-previous";
        next.id = "node-preview-next";
        prev.setAttribute("aria-label", "Previous active tickets");
        next.setAttribute("aria-label", "Next active tickets");
        prev.disabled = p.offset === 0;
        next.disabled = p.offset + p.limit >= p.total;
        prev.onclick = () =>
          void detail(n, button, Math.max(0, p.offset - p.limit), false);
        next.onclick = () => void detail(n, button, p.offset + p.limit, false);
        pager.append(
          prev,
          textElement(
            d,
            "span",
            p.total
              ? `${p.offset + 1}-${p.offset + p.items.length} of ${p.total}`
              : "0 tickets",
            "position",
          ),
          next,
        );
        work.append(pager);
        if (
          !focus &&
          (d.activeElement === d.body || d.activeElement === focusBefore)
        ) {
          const preferred =
            focusBefore.id === "node-preview-previous" ? prev : next;
          (!preferred.disabled
            ? preferred
            : !prev.disabled
              ? prev
              : !next.disabled
                ? next
                : el("node-close")
          ).focus();
        }
      }
      el("nodes-status").textContent = "Node work loaded: " + node.name;
    } catch (e) {
      if (
        active &&
        !disposed &&
        current === detailGeneration &&
        board === generation
      ) {
        work.textContent = viewMessage(
          e,
          "Node details could not load. Close and select it again.",
        );
        el("nodes-status").textContent =
          "Node details could not load. Close and select it again.";
        if (
          !focus &&
          !focusBefore.isConnected &&
          (d.activeElement === d.body || d.activeElement === focusBefore)
        )
          el("node-close").focus();
      }
    }
  }
  function graph(f: Federation) {
    const layout = layoutFederation(
      f.nodes.map((n) => n.name),
      f.edges,
    );
    const ns = "http://www.w3.org/2000/svg",
      svg = d.createElementNS(ns, "svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Federation relationships");
    svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    svg.setAttribute("width", String(layout.width));
    svg.setAttribute("height", String(layout.height));
    svg.setAttribute("class", "federation-graph");
    const defs = d.createElementNS(ns, "defs");
    for (const type of ["build", "runtime"]) {
      const marker = d.createElementNS(ns, "marker"),
        arrow = d.createElementNS(ns, "path");
      marker.id = "relation-arrow-" + type;
      for (const [key, value] of Object.entries({
        viewBox: "0 0 10 10",
        refX: "10",
        refY: "5",
        markerWidth: "7",
        markerHeight: "7",
        orient: "auto",
        markerUnits: "userSpaceOnUse",
      }))
        marker.setAttribute(key, value);
      arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
      arrow.setAttribute(
        "fill",
        type === "runtime" ? "var(--runtime-link)" : "var(--copper)",
      );
      marker.append(arrow);
      defs.append(marker);
    }
    svg.append(defs);
    for (const { edge, path: route } of layout.routes) {
      const path = d.createElementNS(ns, "path"),
        title = d.createElementNS(ns, "title");
      path.setAttribute("class", `federation-edge ${edge.type}`);
      path.setAttribute("d", route);
      path.setAttribute("marker-end", `url(#relation-arrow-${edge.type})`);
      path.dataset.from = edge.from;
      path.dataset.to = edge.to;
      title.textContent = `${edge.type}: ${edge.from} → ${edge.to}${edge.via ? " · " + edge.via : ""}`;
      path.append(title);
      svg.append(path);
    }
    const list = el("nodes-list");
    list.style.width = layout.width + "px";
    list.style.height = layout.height + "px";
    list.replaceChildren(svg);
    buttons.clear();
    const current = generation,
      nodes = new Map(f.nodes.map((n) => [n.name, n]));
    for (const box of layout.nodes) {
      const n = nodes.get(box.name)!;
      const b = textElement(d, "button", "", "node-card");
      b.type = "button";
      b.dataset.node = n.name;
      b.setAttribute("aria-pressed", "false");
      b.setAttribute(
        "aria-label",
        `${n.name} · ${n.role} · ${health(n)} · ${cacheText(n)}`,
      );
      b.title = `${n.name} · ${n.kind} · ${n.stack || "Stack not specified"}`;
      b.style.left = box.x + "px";
      b.style.top = box.y + "px";
      b.style.width = box.width + "px";
      b.style.height = box.height + "px";
      const name = textElement(d, "span", n.name, "node-name");
      const dot = textElement(d, "span", "", "node-health");
      dot.dataset.health = n.health;
      dot.setAttribute("aria-hidden", "true");
      name.prepend(dot);
      const meter = textElement(d, "span", "", "node-progress");
      meter.setAttribute("aria-hidden", "true");
      if (n.cache && n.cache.ticketCount > 0) {
        const fill = textElement(d, "span", "");
        fill.style.width =
          Math.min(
            100,
            Math.max(0, (n.cache.completeTickets / n.cache.ticketCount) * 100),
          ) + "%";
        meter.append(fill);
      }
      b.append(
        name,
        textElement(d, "span", n.role || n.kind, "node-caption"),
        meter,
        textElement(
          d,
          "span",
          (n.cache
            ? `${n.cache.completeTickets}/${n.cache.ticketCount} · `
            : "") + `Cached · ${n.cacheState}`,
          "node-cache",
        ),
      );
      b.onclick = () => {
        if (active && !disposed && !busy && current === generation)
          void detail(n, b);
      };
      buttons.set(n.name, b);
      list.append(b);
    }
    const builds = layout.routes.filter((r) => r.edge.type === "build").length;
    const runtime = layout.routes.length - builds;
    el("nodes-summary").textContent =
      `${layout.nodes.length} ${layout.nodes.length === 1 ? "project" : "projects"} · ${builds} build ${builds === 1 ? "dependency" : "dependencies"} · ${runtime} runtime ${runtime === 1 ? "link" : "links"}`;
    return list;
  }
  function render(f: Federation, focusBefore?: HTMLElement) {
    if (!Array.isArray(f?.nodes) || !Array.isArray(f.edges))
      throw new ViewError("Nodes could not load.");
    federation = f;
    const list = graph(f);
    if (!f.nodes.length) {
      list.style.width = "100%";
      list.style.height = "auto";
      list.replaceChildren(
        textElement(
          d,
          "p",
          f.isOrchestrator
            ? "No nodes configured."
            : "This project is not a federation orchestrator.",
          "empty",
        ),
      );
    }
    el("nodes-warnings").replaceChildren(
      ...f.warnings.map((w) => textElement(d, "p", w)),
    );
    el("nodes-status").textContent = f.scannedAt
      ? "Cached scan: " + new Date(f.scannedAt).toLocaleString()
      : "No cached scan available.";
    if (
      focusBefore?.dataset.node &&
      (d.activeElement === d.body || d.activeElement === focusBefore)
    ) {
      const replacement = [
        ...list.querySelectorAll<HTMLButtonElement>(".node-card"),
      ].find((b) => b.dataset.node === focusBefore.dataset.node);
      (replacement ?? el("refresh")).focus();
    }
    ready = true;
  }
  async function refresh() {
    if (!active || disposed) return;
    const current = ++generation;
    const focusBefore = d.activeElement as HTMLElement;
    busy = true;
    close();
    el("nodes-error").textContent = "";
    el("nodes-status").textContent = "Loading nodes…";
    el("nodes-list")
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = true));
    try {
      const r = await call("storybloq_federation", {});
      if (!active || disposed || current !== generation) return;
      if (r.isError) throw new ViewError(repairMessage(r));
      render(r._meta?.federation, focusBefore);
    } catch (e) {
      if (active && !disposed && current === generation) {
        el("nodes-error").textContent = viewMessage(
          e,
          "Nodes could not load. Refresh to try again.",
        );
        el("nodes-status").textContent =
          "Previously displayed data may be out of date. Refresh to try again.";
      }
    } finally {
      if (current === generation) busy = false;
    }
  }
  el("node-close").onclick = () => close(true);
  el("node-detail").onkeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    }
  };
  return {
    refresh,
    autoRefresh() {
      if (ready && !busy && el("node-detail").hidden) void refresh();
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
