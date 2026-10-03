export type ItemKind = "tickets" | "issues";
export type EditableValue = string | string[] | null;
export interface ItemEditor {
  kind: ItemKind;
  id: string;
  displayId: string;
  revision: string;
  fields: Record<string, EditableValue>;
  limitedFields: string[];
  phases: { key: string; name: string }[];
  canReopen: boolean;
}
