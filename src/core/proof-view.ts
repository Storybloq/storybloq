/**
 * C-v4.1 commit 5 (pen ruling Q1): the proof view both surfaces print. The
 * get tools carry `proof` only when `proofPage` is passed; `storybloq proof`
 * prints the same view.
 */
import { ProjectLoaderError } from "./errors.js";
import { proveRef, type ProofResult } from "./proof.js";

export interface ProofView {
  readonly json: ProofResult | { readonly outcome: "unproven"; readonly reason: string };
  readonly lines: string[];
}

export function proofLines(p: ProofView["json"]): string[] {
  const head = `Proof: ${p.outcome}${"reason" in p && p.reason !== undefined ? ` (${p.reason})` : ""}`;
  if (!("children" in p)) return [head];
  const lines = [p.verifiedAt !== null ? `${head}, verified ${p.verifiedAt}` : head];
  if (p.children.length > 1) for (const c of p.children) lines.push(`- ${c.ref}: ${c.outcome}${c.reason !== undefined ? ` (${c.reason})` : ""}`);
  if (p.evidenceTotal > 0) {
    lines.push(`Evidence (page ${p.page} of ${p.pages}, ${p.evidenceTotal} total):`);
    for (const e of p.evidence) lines.push(`- ${e.receipt} ${e.result} ${e.deviceClass ?? "unknown device"} at ${e.sha.slice(0, 12)}: ${e.status}${e.detail !== undefined ? ` (${e.detail})` : ""}`);
  }
  return lines;
}

/** One page of proof for a ref on this board; a refusal reads as unproven with its message. */
export async function proofView(root: string, ref: string, page: number): Promise<ProofView> {
  let json: ProofView["json"];
  try {
    json = await proveRef(root, ref, { page });
  } catch (e) {
    if (!(e instanceof ProjectLoaderError)) throw e;
    json = { outcome: "unproven", reason: e.message };
  }
  return { json, lines: proofLines(json) };
}
