import type { EditableValue } from "./editor-types.js";
export interface NoteCard {
  id: string;
  displayId: string;
  title: string | null;
  preview: string;
  tags: string[];
  hiddenTags: number;
  status: "active" | "archived";
  updatedDate: string;
}
export interface NotesPage {
  items: NoteCard[];
  total: number;
  offset: number;
  limit: number;
}
export interface NotePreview extends NoteCard {
  revision: string;
  content: string;
  offset: number;
  nextOffset: number | null;
}
export interface NoteEditor {
  kind: "notes";
  id: string;
  displayId: string;
  revision: string;
  fields: Record<string, EditableValue>;
  limitedFields: string[];
  updatedDate?: string;
}
