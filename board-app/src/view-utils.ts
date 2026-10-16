export type Result = { isError?: boolean; _meta?: Record<string, any> };
export type Call = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Result>;
export function repairMessage(result?: Result) {
  const info = result?._meta?.boardError;
  return info?.code === "storybloq_board_error" &&
    typeof info.message === "string" &&
    info.message.length <= 500
    ? info.message
    : "Check the local project connection, then refresh.";
}
export function textElement<K extends keyof HTMLElementTagNameMap>(
  d: Document,
  tag: K,
  text: string,
  className = "",
) {
  const el = d.createElement(tag);
  el.textContent = text;
  el.className = className;
  return el;
}
/** A small inert Markdown subset. Unknown syntax remains text; no HTML, URLs or media. */
export function markdown(d: Document, content: string) {
  const fragment = d.createDocumentFragment();
  const inline = (target: HTMLElement, text: string) => {
    const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
    let start = 0;
    for (const match of text.matchAll(pattern)) {
      target.append(d.createTextNode(text.slice(start, match.index)));
      target.append(
        textElement(d, match[1] ? "strong" : "code", match[1] ?? match[2]),
      );
      start = match.index! + match[0].length;
    }
    target.append(d.createTextNode(text.slice(start)));
  };
  let code: string[] | undefined, list: HTMLUListElement | undefined;
  for (const line of content.split("\n")) {
    if (line.startsWith("```")) {
      if (code) {
        const pre = textElement(d, "pre", "");
        pre.append(textElement(d, "code", code.join("\n")));
        fragment.append(pre);
        code = undefined;
      } else code = [];
      list = undefined;
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      list = undefined;
      continue;
    }
    if (/^[-*] /.test(line)) {
      if (!list) {
        list = d.createElement("ul");
        fragment.append(list);
      }
      const li = d.createElement("li");
      inline(li, line.slice(2));
      list.append(li);
      continue;
    }
    list = undefined;
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const el = d.createElement(
      heading ? `h${Math.min(heading[1].length + 1, 6)}` : "p",
    );
    inline(el, heading?.[2] ?? line);
    fragment.append(el);
  }
  if (code) {
    const pre = textElement(d, "pre", "");
    pre.append(textElement(d, "code", code.join("\n")));
    fragment.append(pre);
  }
  return fragment;
}

export class ViewError extends Error {}
export const viewMessage = (error: unknown, fallback: string) =>
  error instanceof ViewError ? error.message : fallback;
