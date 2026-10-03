import type {
  SessionsPayload,
  SessionRecord,
  PresenceRow,
} from "./sessions-types.js";
import {
  presenceActivity,
  sessionStatus,
  parseSessionTime,
  milestoneProjection,
} from "./session-projection.js";
import {
  textElement,
  repairMessage,
  ViewError,
  viewMessage,
  type Call,
} from "./view-utils.js";

const activityLabels = {
  working: "Recent tool activity",
  maybeWorking: "May still be working",
  idleRecent: "Recently idle",
  unknown: "Activity unknown",
  stale: "Stale record",
  ended: "Ended",
};
const statusLabels = {
  needsInput: "Input needed",
  unresponsive: "Reported unresponsive",
  stale: "Signals stale",
  degraded: "Needs attention",
  working: "Reported working",
};
const elapsed = (at: string | null | undefined, now: number) => {
  const time = parseSessionTime(at);
  if (time === null || now - time < -120000)
    return "Unknown (clock or timestamp unavailable)";
  const seconds = Math.floor(Math.max(0, now - time) / 1000);
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};
export function mountSessions(d: Document, call: Call) {
  const el = (id: string) => d.getElementById(id)!;
  let active = false,
    disposed = false,
    busy = false,
    generation = 0,
    offset = 0,
    pendingOffset: number | undefined,
    model: SessionsPayload | undefined;
  let previousStatus: string | undefined,
    previousRoster = new Map<string, string>(),
    previousOffset = 0;
  const setText = (id: string, text: string) => {
    if (el(id).textContent !== text) el(id).textContent = text;
  };
  function pair(
    parent: HTMLElement,
    label: string,
    value: string | null | undefined,
  ) {
    if (value == null || value === "") return;
    const row = textElement(d, "div", "", "session-fact");
    row.append(textElement(d, "dt", label), textElement(d, "dd", value));
    parent.append(row);
  }
  function listDetails(
    parent: HTMLElement,
    id: string,
    title: string,
    values: string[],
  ) {
    if (!values.length) return;
    const details = d.createElement("details"),
      summary = textElement(d, "summary", title),
      list = d.createElement("ul");
    details.id = id;
    summary.id = id + "-summary";
    for (const value of values) list.append(textElement(d, "li", value));
    details.append(summary, list);
    parent.append(details);
  }
  function autonomousFacts(
    card: HTMLElement,
    record: SessionRecord,
    now: number,
  ) {
    const facts = d.createElement("dl");
    facts.className = "session-facts";
    pair(facts, "Stage", record.state);
    pair(facts, "Substage", record.substage);
    pair(facts, "Duration", elapsed(record.startedAt, now));
    pair(
      facts,
      "Substage duration",
      record.substageStartedAt ? elapsed(record.substageStartedAt, now) : null,
    );
    pair(facts, "Recorded at", record.observedAt);
    pair(facts, "Guide context pressure", record.contextPressure);
    if (record.tokenPressure) {
      const p = record.tokenPressure;
      pair(
        facts,
        "Token pressure",
        p.state +
          (p.pctBucket !== null ? ` (reported bucket ${p.pctBucket}%)` : ""),
      );
    }
    card.append(facts);
  }
  function autonomousAlerts(card: HTMLElement, record: SessionRecord) {
    if (record.alerts.length) {
      const alerts = textElement(d, "div", "", "session-alerts");
      for (const a of record.alerts) {
        const box = textElement(d, "section", "", "session-alert " + a.tone);
        box.append(
          textElement(d, "h4", a.title),
          textElement(d, "p", a.detail),
        );
        alerts.append(box);
      }
      card.append(alerts);
    }
  }
  function autonomousQueue(card: HTMLElement, record: SessionRecord) {
    if (record.queue.total) {
      card.append(
        textElement(
          d,
          "h4",
          `Queue · ${record.queue.completed} of ${record.queue.total} complete`,
        ),
      );
      const progress = d.createElement("progress");
      progress.max = record.queue.total;
      progress.value = record.queue.completed;
      progress.setAttribute("aria-label", "Completed work in session queue");
      card.append(progress);
      listDetails(
        card,
        "session-queue",
        "Queue items",
        record.queue.items.map((i) => `${i.id} · ${i.status}`),
      );
    }
    listDetails(
      card,
      "session-completed",
      `Completed this session (${record.completedThisSession.length})`,
      record.completedThisSession,
    );
    listDetails(
      card,
      "session-subprocesses",
      `Recorded subprocesses (${record.runningSubprocesses.length})`,
      record.runningSubprocesses.map(
        (p) =>
          `${p.category} · PID ${p.pid} · ${p.stage} · started ${p.startedAt}`,
      ),
    );
    if (record.lastReviewVerdict) {
      const r = record.lastReviewVerdict;
      listDetails(card, "session-review", "Last review", [
        `${r.verdict} · ${r.stage} · round ${r.round}`,
        `${r.findingCount} findings · ${r.criticalCount} critical · ${r.majorCount} major · ${r.suggestionCount} suggestions`,
        r.summary,
      ]);
    }
  }
  function autonomousDetails(card: HTMLElement, record: SessionRecord) {
    const details = d.createElement("details");
    details.id = "session-metadata";
    const summary = textElement(d, "summary", "Session details");
    summary.id = "session-metadata-summary";
    const facts = d.createElement("dl");
    facts.className = "session-facts";
    pair(facts, "Last MCP call", record.lastMcpCall);
    pair(facts, "Last guide call", record.lastGuideCall);
    pair(facts, "Branch", record.branch);
    pair(facts, "Session", record.sessionId);
    pair(facts, "Source", record.source);
    if (record.tokenPressure) {
      const p = record.tokenPressure;
      pair(
        facts,
        "Token estimate source",
        p.ceilingSource +
          (p.ceilingConfidence
            ? " · " + p.ceilingConfidence + " confidence"
            : ""),
      );
    }
    details.append(
      summary,
      facts,
      textElement(
        d,
        "p",
        record.telemetryAvailable
          ? "Health signals include the recorded session telemetry. These signals do not establish process liveness."
          : "Live telemetry unavailable. Showing the status record's health signals.",
        "muted",
      ),
    );
    card.append(details);
  }
  function autonomous(record: SessionRecord, now: number) {
    const card = textElement(d, "section", "", "session-card autonomous-card");
    card.append(
      textElement(d, "p", "Autonomous session", "eyebrow"),
      textElement(
        d,
        "h3",
        record.currentWork
          ? `${record.currentWork.id} · ${record.currentWork.title}`
          : "Project session",
      ),
      textElement(d, "p", statusLabels[record.derivedStatus], "session-state"),
    );
    if (record.currentWork?.tag)
      card.append(textElement(d, "span", record.currentWork.tag, "tag"));
    autonomousFacts(card, record, now);
    autonomousAlerts(card, record);
    autonomousQueue(card, record);
    autonomousDetails(card, record);
    if (record.truncated)
      card.append(
        textElement(
          d,
          "p",
          "Some fields or lists were shortened to fit this screen. Full records remain in your project.",
          "muted",
        ),
      );
    return card;
  }
  function interactive(row: PresenceRow, now: number) {
    const card = textElement(d, "article", "", "session-card");
    card.dataset.presenceId = row.sessionId;
    card.append(
      textElement(d, "p", "Interactive session", "eyebrow"),
      textElement(d, "h3", row.sessionId),
      textElement(d, "p", activityLabels[row.activity.state], "session-state"),
    );
    if (row.activity.state === "maybeWorking")
      card.append(
        textElement(
          d,
          "p",
          "The tool has been open beyond the activity window. A long task, idle process and stopped process cannot be distinguished by this record.",
          "muted",
        ),
      );
    const facts = d.createElement("dl");
    facts.className = "session-facts";
    pair(facts, "Duration", elapsed(row.startedAt, now));
    pair(facts, "Last event", row.lastEventAt);
    pair(facts, "Source", row.source);
    pair(facts, "Agents", row.agentCount ? String(row.agentCount) : null);
    card.append(facts);
    if (row.openTools.length) {
      const tools = textElement(d, "ul", "", "session-tools");
      for (const t of row.openTools)
        tools.append(
          textElement(
            d,
            "li",
            t.tool +
              (t.target ? " · " + t.target : "") +
              " · open " +
              elapsed(t.startedAt, now),
          ),
        );
      card.append(tools);
    }
    if (row.arrangements.length)
      card.append(
        textElement(
          d,
          "p",
          row.arrangements
            .map((a) => `${a.role} · ${a.lifecycle} · ${a.arrangementId}`)
            .join("; "),
          "muted",
        ),
      );
    if (row.supervision) card.append(textElement(d, "p", row.supervision));
    if (row.arrangementPresenceTruncated)
      card.append(
        textElement(
          d,
          "p",
          "Additional arrangement roles were not included in this record.",
          "muted",
        ),
      );
    if (row.milestone) {
      const m = row.milestone;
      card.append(
        textElement(
          d,
          "p",
          `Self-reported · ${m.label} · ${m.clockAnomaly ? "elapsed unknown (clock skew)" : `${elapsed(m.at, now)} ago`}${m.overdue ? " · may be worth checking" : ""}`,
        ),
      );
      if (m.note) card.append(textElement(d, "p", m.note, "muted"));
    }
    return card;
  }
  function projectTime(source: SessionsPayload, now: number): SessionsPayload {
    const record = source.status.record;
    return {
      ...source,
      status: record
        ? {
            ...source.status,
            record: { ...record, derivedStatus: sessionStatus(record, now) },
          }
        : source.status,
      presence: {
        ...source.presence,
        items: source.presence.items
          .map((row) => ({
            ...row,
            activity: presenceActivity(row, now),
            milestone: row.milestone
              ? milestoneProjection(
                  {
                    kind: row.milestone.kind,
                    at: row.milestone.at,
                    gateName: row.milestone.gateName ?? undefined,
                    note: row.milestone.note ?? undefined,
                  },
                  now,
                )
              : null,
          }))
          .filter((row) => row.activity.visible),
      },
    };
  }
  function announce(value: SessionsPayload) {
    const status = value.status.record
      ? value.status.record.sessionId + ":" + value.status.record.derivedStatus
      : value.status.kind;
    const roster = new Map(
      value.presence.items.map((row) => [row.sessionId, row.activity.state]),
    );
    const changes: string[] = [];
    if (status !== previousStatus) {
      if (value.status.record)
        changes.push(statusLabels[value.status.record.derivedStatus]);
      else if (value.status.kind === "inactive" && previousStatus !== undefined)
        changes.push("No autonomous session is recorded as active.");
      else if (value.status.kind === "missing" && previousStatus !== undefined)
        changes.push(
          "Autonomous status record is missing; active session information is unavailable.",
        );
      else if (["malformed", "unsupported"].includes(value.status.kind))
        changes.push("Autonomous status " + value.status.kind);
    }
    if (value.presence.offset === previousOffset) {
      if (previousStatus !== undefined)
        for (const [id, state] of roster)
          if (!previousRoster.has(id))
            changes.push(
              id +
                " recorded activity: " +
                activityLabels[state as keyof typeof activityLabels],
            );
      for (const [id, state] of roster)
        if (previousRoster.has(id) && previousRoster.get(id) !== state)
          changes.push(
            id +
              " activity: " +
              activityLabels[state as keyof typeof activityLabels],
          );
      for (const id of previousRoster.keys())
        if (!roster.has(id))
          changes.push(id + " no longer in this roster page");
    }
    if (previousStatus === undefined && !changes.length)
      changes.push(
        `${value.presence.items.length} interactive session records loaded`,
      );
    if (changes.length) setText("sessions-live", changes.join(". "));
    previousStatus = status;
    previousRoster = roster;
    previousOffset = value.presence.offset;
  }
  function render(source: SessionsPayload) {
    const value = projectTime(source, Date.now()),
      body = el("sessions-body"),
      oldFocus = d.activeElement as HTMLElement,
      focusId = oldFocus?.id;
    const opened = new Set(
      Array.from(
        body.querySelectorAll<HTMLDetailsElement>("details[open]"),
      ).map((x) => x.id),
    );
    body.replaceChildren();
    if (value.status.record)
      body.append(autonomous(value.status.record, Date.now()));
    else {
      const messages = {
        missing:
          "Autonomous status missing. No status record has been written.",
        inactive: "No autonomous session is recorded as active.",
        malformed:
          "Autonomous status malformed. Repair the local record, then refresh.",
        unsupported:
          "Autonomous status unsupported. A newer plugin is needed to read this version.",
        active: "Autonomous status unavailable.",
      };
      body.append(
        textElement(d, "p", messages[value.status.kind], "session-empty"),
      );
    }
    const heading = textElement(d, "h3", "Interactive sessions");
    body.append(heading);
    const grid = textElement(d, "div", "", "sessions-grid");
    for (const row of value.presence.items)
      grid.append(interactive(row, Date.now()));
    body.append(grid);
    if (!value.presence.items.length)
      body.append(
        textElement(
          d,
          "p",
          "No visible interactive session records on this page.",
          "session-empty",
        ),
      );
    const p = value.presence;
    setText(
      "sessions-recorded",
      "Read at " +
        value.loadedAt +
        " · Event records decay with time; they are not process heartbeats.",
    );
    setText(
      "sessions-diagnostics",
      [
        p.unread
          ? `${p.unread} presence candidates not read (100-record limit).`
          : "",
        p.malformed
          ? `${p.malformed} malformed presence records unavailable.`
          : "",
        p.unsupported
          ? `${p.unsupported} unsupported presence records need a newer plugin.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    setText(
      "sessions-position",
      p.total
        ? `${p.offset + 1}-${p.offset + p.items.length} of ${p.total} recorded visible sessions`
        : "No interactive session records",
    );
    const previous = el("sessions-previous") as HTMLButtonElement,
      next = el("sessions-next") as HTMLButtonElement;
    previous.disabled = p.offset === 0;
    next.disabled = p.offset + p.limit >= p.total;
    for (const id of opened) {
      const details = d.getElementById(id) as HTMLDetailsElement | null;
      if (details) details.open = true;
    }
    if (
      oldFocus &&
      !oldFocus.isConnected &&
      (d.activeElement === d.body || d.activeElement === oldFocus)
    )
      ((focusId && d.getElementById(focusId)) || el("sessions-title")).focus();
    if (oldFocus === next && next.disabled)
      (previous.disabled ? el("sessions-title") : previous).focus();
    if (oldFocus === previous && previous.disabled)
      (next.disabled ? el("sessions-title") : next).focus();
    announce(value);
  }
  async function refresh() {
    if (!active || disposed || busy) return;
    const request = ++generation;
    busy = true;
    el("sessions-screen").setAttribute("aria-busy", "true");
    try {
      const r = await call("storybloq_sessions", { offset });
      if (!active || disposed || request !== generation) return;
      if (r.isError) throw new ViewError(repairMessage(r));
      const value = r._meta?.sessions as SessionsPayload | undefined;
      if (
        !value ||
        typeof value.loadedAt !== "string" ||
        !value.status ||
        !value.presence ||
        !Array.isArray(value.presence.items)
      )
        throw new ViewError(
          "Session information could not load. Refresh to try again.",
        );
      if (pendingOffset !== undefined) return;
      render(value);
      model = value;
      offset = value.presence.offset;
      setText("sessions-error", "");
      setText("sessions-stale", "");
      el("sessions-stale").hidden = true;
    } catch (error) {
      if (active && !disposed && request === generation) {
        setText(
          "sessions-error",
          viewMessage(
            error,
            "Session information could not load. Check the local connection, then refresh.",
          ) + (model ? " Showing stale data from the previous read." : ""),
        );
        if (model) {
          setText(
            "sessions-stale",
            "Stale data: showing the previous successful read. Refresh to update these records.",
          );
          el("sessions-stale").hidden = false;
        } else
          el("sessions-body").textContent = "Session information unavailable.";
      }
    } finally {
      if (request === generation) {
        busy = false;
        el("sessions-screen").setAttribute("aria-busy", "false");
        if (pendingOffset !== undefined) {
          offset = pendingOffset;
          pendingOffset = undefined;
          void refresh();
        }
      }
    }
  }
  el("sessions-previous").onclick = () => {
    const wanted = Math.max(0, (model?.presence.offset ?? offset) - 20);
    if (busy) pendingOffset = wanted;
    else {
      offset = wanted;
      void refresh();
    }
  };
  el("sessions-next").onclick = () => {
    const wanted = Math.min(99, (model?.presence.offset ?? offset) + 20);
    if (busy) pendingOffset = wanted;
    else {
      offset = wanted;
      void refresh();
    }
  };
  return {
    refresh,
    autoRefresh() {
      if (active && !disposed) {
        if (model) render(model);
        void refresh();
      }
    },
    setActive(value: boolean) {
      if (active === value) return;
      active = value;
      generation++;
      pendingOffset = undefined;
      busy = false;
      el("sessions-screen").setAttribute("aria-busy", "false");
    },
    dispose() {
      disposed = true;
      active = false;
      generation++;
      pendingOffset = undefined;
      busy = false;
    },
  };
}
