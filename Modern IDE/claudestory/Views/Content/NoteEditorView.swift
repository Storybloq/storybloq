import SwiftUI
import Fabric

// MARK: - Note Editor View

/// Always-editable note view (like Apple Notes — no view/edit toggle).
struct NoteEditorView: View {
    let note: Note
    let onUpdate: (_ id: String, _ content: String?, _ title: String??, _ tags: [String]?, _ clearTags: Bool, _ status: NoteStatus?) -> Void
    let onDelete: (_ id: String) -> Void
    let onBack: () -> Void

    @State private var title: String
    @State private var content: String
    @State private var tags: [String]
    @State private var status: NoteStatus
    @State private var newTag: String = ""
    @State private var showDeleteConfirmation = false
    @State private var saveTask: Task<Void, Never>?
    @State private var pendingExternalNote: Note?

    init(
        note: Note,
        onUpdate: @escaping (_ id: String, _ content: String?, _ title: String??, _ tags: [String]?, _ clearTags: Bool, _ status: NoteStatus?) -> Void,
        onDelete: @escaping (_ id: String) -> Void,
        onBack: @escaping () -> Void
    ) {
        self.note = note
        self.onUpdate = onUpdate
        self.onDelete = onDelete
        self.onBack = onBack
        self._title = State(initialValue: note.title ?? "")
        self._content = State(initialValue: note.content)
        self._tags = State(initialValue: note.tags)
        self._status = State(initialValue: note.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FabricSpacing.md) {
            // Back button + archived badge
            HStack {
                Button {
                    onBack()
                } label: {
                    HStack(spacing: FabricSpacing.xs) {
                        Image(systemName: "chevron.left")
                        Text("Notes")
                    }
                    .fabricTypography(.caption)
                }
                .buttonStyle(.fabricGhost)

                Spacer()

                if note.status == .archived {
                    FabricBadge("Archived")
                }
            }

            // Title
            FabricTextField(
                placeholder: "Untitled",
                text: $title
            )
            .onChange(of: title) { _, _ in debouncedSave() }

            // Content
            FabricTextEditor(
                placeholder: "Write something...",
                text: $content,
                minHeight: 200,
                maxHeight: 600
            )
            .onChange(of: content) { _, _ in debouncedSave() }

            // Tags
            VStack(alignment: .leading, spacing: FabricSpacing.xs) {
                Text("Tags")
                    .fabricTypography(.caption)
                    .foregroundStyle(FabricColors.inkTertiary)

                FabricFlowLayout(spacing: FabricSpacing.xs) {
                    ForEach(tags, id: \.self) { tag in
                        FabricChip(tag, accent: .sage, isRemovable: true) {
                            tags.removeAll { $0 == tag }
                            debouncedSave()
                        }
                    }

                    // Add tag inline
                    TextField("Add tag...", text: $newTag)
                        .textFieldStyle(.plain)
                        .frame(width: 100)
                        .onSubmit {
                            let trimmed = newTag.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                            guard !trimmed.isEmpty, !tags.contains(trimmed) else { return }
                            tags.append(trimmed)
                            newTag = ""
                            debouncedSave()
                        }
                }
            }

            // Archive + Delete
            HStack {
                Spacer()

                Button {
                    let newStatus: NoteStatus = status == .active ? .archived : .active
                    Log.info("NoteEditor: \(newStatus == .archived ? "archiving" : "unarchiving") \(note.id)", tag: "Notes")
                    status = newStatus
                    onUpdate(note.id, nil, nil, nil, false, newStatus)
                    if newStatus == .archived { onBack() }
                } label: {
                    Label(
                        status == .active ? "Archive" : "Unarchive",
                        systemImage: status == .active ? "archivebox" : "tray.and.arrow.up"
                    )
                    .fabricTypography(.caption)
                }
                .buttonStyle(.fabricGhost)

                Button(role: .destructive) {
                    showDeleteConfirmation = true
                } label: {
                    Label("Delete", systemImage: "trash")
                        .fabricTypography(.caption)
                }
                .buttonStyle(.fabricGhost)
            }
        }
        .padding(FabricSpacing.md)
        .task(id: note.id) {
            Log.debug("NoteEditor: resetting state for \(note.id)", tag: "Notes")
            saveTask?.cancel()
            saveTask = nil
            title = note.title ?? ""
            content = note.content
            tags = note.tags
            status = note.status
        }
        .onChange(of: note) { _, newNote in
            if saveTask != nil {
                pendingExternalNote = newNote
                return
            }
            Log.debug("NoteEditor: external update for \(newNote.id)", tag: "Notes")
            title = newNote.title ?? ""
            content = newNote.content
            tags = newNote.tags
            status = newNote.status
        }
        .confirmationDialog("Delete Note", isPresented: $showDeleteConfirmation) {
            Button("Delete", role: .destructive) {
                Log.info("NoteEditor: deleting \(note.id)", tag: "Notes")
                onDelete(note.id)
                onBack()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Delete \(note.id)? This cannot be undone.")
        }
    }

    // MARK: - Debounced Save

    private func debouncedSave() {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            Log.info("NoteEditor: saving \(note.id)", tag: "Notes")
            let titleToSend: String?? = title.isEmpty ? .some(nil) : .some(title)
            let tagsChanged = tags != note.tags
            onUpdate(
                note.id,
                content,
                titleToSend,
                tagsChanged ? tags : nil,
                false,
                status
            )
            saveTask = nil
            if let pending = pendingExternalNote {
                pendingExternalNote = nil
                Log.debug("NoteEditor: applying deferred external update for \(pending.id)", tag: "Notes")
                title = pending.title ?? ""
                content = pending.content
                tags = pending.tags
                status = pending.status
            }
        }
    }
}
