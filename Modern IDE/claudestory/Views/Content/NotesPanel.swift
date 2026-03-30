import SwiftUI
import Fabric

// MARK: - Notes Panel

/// Notes sidebar content: list view (grid + search + filters) or editor view.
/// Driven by `editingNoteID` — nil shows the list, non-nil shows the editor.
struct NotesPanel: View {
    let state: ProjectState
    let onCreateNote: (_ content: String, _ title: String?, _ tags: [String]) -> Void
    let onUpdateNote: (_ id: String, _ content: String?, _ title: String??, _ tags: [String]?, _ clearTags: Bool, _ status: NoteStatus?) -> Void
    let onDeleteNote: (_ id: String) -> Void

    @State private var editingNoteID: String?
    @State private var searchText: String = ""
    @State private var statusFilter: NoteStatus? = .active
    @State private var pendingNewNoteCount: Int?

    private var filteredNotes: [Note] {
        var notes = state.notes

        // Status filter
        if let filter = statusFilter {
            notes = notes.filter { $0.status == filter }
        }

        // Search filter
        if !searchText.isEmpty {
            let query = searchText.lowercased()
            notes = notes.filter { note in
                (note.title?.lowercased().contains(query) ?? false) ||
                note.content.lowercased().contains(query) ||
                note.tags.contains { $0.lowercased().contains(query) }
            }
        }

        // Sort: most recently updated first
        return notes.sorted { $0.updatedDate > $1.updatedDate }
    }

    var body: some View {
        let _ = Log.debug("NotesPanel: editing=\(editingNoteID ?? "nil") filter=\(statusFilter?.rawValue ?? "all") search=\(searchText.isEmpty ? "none" : searchText) count=\(filteredNotes.count)", tag: "Notes")
        if let noteID = editingNoteID, let note = state.note(byID: noteID) {
            let _ = Log.debug("NotesPanel: showing editor for \(noteID)", tag: "Notes")
            NoteEditorView(
                note: note,
                onUpdate: onUpdateNote,
                onDelete: onDeleteNote,
                onBack: {
                    Log.info("NotesPanel: back to list from \(noteID)", tag: "Notes")
                    editingNoteID = nil
                }
            )
            .id(noteID)
        } else if editingNoteID != nil {
            Color.clear.onAppear {
                Log.warning("NotesPanel: note \(editingNoteID ?? "") not found in state, resetting", tag: "Notes")
                editingNoteID = nil
            }
        } else {
            notesList
        }
    }

    // MARK: - List View

    private var notesList: some View {
        VStack(spacing: FabricSpacing.sm) {
            // Search
            FabricSearchField(
                placeholder: "Search notes...",
                text: $searchText
            )
            .padding(.horizontal, FabricSpacing.sm)

            // Filters + New button
            HStack(spacing: FabricSpacing.xs) {
                FabricFilterPill(
                    "Active",
                    accent: .sage,
                    isSelected: statusFilter == .active
                ) {
                    statusFilter = statusFilter == .active ? nil : .active
                    Log.info("NotesPanel: filter → \(statusFilter?.rawValue ?? "all")", tag: "Notes")
                }

                FabricFilterPill(
                    "Archived",
                    accent: .ochre,
                    isSelected: statusFilter == .archived
                ) {
                    statusFilter = statusFilter == .archived ? nil : .archived
                    Log.info("NotesPanel: filter → \(statusFilter?.rawValue ?? "all")", tag: "Notes")
                }

                Spacer()

                Button {
                    Log.info("New Note tapped", tag: "Notes")
                    pendingNewNoteCount = state.notes.count
                    onCreateNote("New note", nil, [])
                } label: {
                    Label("New Note", systemImage: "plus")
                        .fabricTypography(.caption)
                }
                .buttonStyle(.fabricGhost)
            }
            .padding(.horizontal, FabricSpacing.sm)

            // Grid
            if filteredNotes.isEmpty {
                Spacer()
                FabricEmptyState(
                    systemImage: "note.text",
                    title: searchText.isEmpty ? "No notes yet" : "No results",
                    subtitle: searchText.isEmpty ? "Create a note to capture ideas" : "Try a different search"
                )
                Spacer()
            } else {
                ScrollView {
                    LazyVGrid(
                        columns: [
                            GridItem(.flexible(), spacing: FabricSpacing.sm),
                            GridItem(.flexible(), spacing: FabricSpacing.sm)
                        ],
                        spacing: FabricSpacing.sm
                    ) {
                        ForEach(filteredNotes) { note in
                            NoteCardView(note: note) {
                                Log.info("NotesPanel: selected \(note.id)", tag: "Notes")
                                editingNoteID = note.id
                            }
                        }
                    }
                    .padding(.horizontal, FabricSpacing.sm)
                    .padding(.bottom, FabricSpacing.md)
                }
            }
        }
        .padding(.top, FabricSpacing.sm)
        .onChange(of: state.notes.count) { oldCount, newCount in
            if let expected = pendingNewNoteCount, newCount > expected {
                // A new note appeared — navigate to it (highest ID = newest)
                if let newest = state.notes.sorted(by: { $0.id > $1.id }).first {
                    Log.info("NotesPanel: auto-opening new note \(newest.id)", tag: "Notes")
                    editingNoteID = newest.id
                }
                pendingNewNoteCount = nil
            }
        }
    }
}
