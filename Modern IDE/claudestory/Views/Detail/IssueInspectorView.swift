import SwiftUI
import Fabric

// MARK: - Issue Inspector View

/// Always-editable issue editor for the kanban board inspector sidebar.
/// Uses last-known-model comparison to prevent file-watcher races during editing.
struct IssueInspectorView: View {
    let issueID: String
    let state: ProjectState
    var onUpdateIssue: ((Issue) -> Void)? = nil

    @State private var title = ""
    @State private var impact = ""
    @State private var resolution = ""
    @State private var lastModelTitle = ""
    @State private var lastModelImpact = ""
    @State private var lastModelResolution = ""
    @State private var previousIssueID: String?
    @State private var saveTask: Task<Void, Never>?
    @State private var isPreviewingImpact = false

    private var issue: Issue? {
        state.issue(byID: issueID)
    }

    var body: some View {
        if let issue {
            ScrollView {
                VStack(alignment: .leading, spacing: StorySpacing.lg) {
                    titleSection
                    impactSection
                    resolutionSection
                    phaseSection(issue)
                    severitySection(issue)
                }
                .padding(StorySpacing.md)
            }
            .task(id: issueID) {
                // Flush dirty edits for the previous record before reseeding
                if let oldID = previousIssueID, oldID != issueID,
                   let oldIssue = state.issue(byID: oldID) {
                    saveTask?.cancel()
                    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
                    let trimmedResolution = resolution.trimmingCharacters(in: .whitespacesAndNewlines)
                    let finalTitle = trimmedTitle.isEmpty ? oldIssue.title : trimmedTitle
                    let finalResolution: String?? = trimmedResolution.isEmpty ? .some(nil) : .some(trimmedResolution)
                    if finalTitle != oldIssue.title || impact != oldIssue.impact || trimmedResolution != (oldIssue.resolution ?? "") {
                        Log.info("IssueInspector: flush save for \(oldID)", tag: "Issues")
                        let updated = oldIssue.with(title: finalTitle, impact: impact, resolution: finalResolution)
                        onUpdateIssue?(updated)
                    }
                } else {
                    saveTask?.cancel()
                }
                previousIssueID = issueID
                title = issue.title
                impact = issue.impact
                resolution = issue.resolution ?? ""
                lastModelTitle = issue.title
                lastModelImpact = issue.impact
                lastModelResolution = issue.resolution ?? ""
                isPreviewingImpact = !issue.impact.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            .onChange(of: issue) { _, newIssue in
                // Title: clean if normalized UI matches lastModel or incoming
                let trimmedUI = title.trimmingCharacters(in: .whitespacesAndNewlines)
                let trimmedLast = lastModelTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                let trimmedNew = newIssue.title.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmedUI == trimmedLast || trimmedUI == trimmedNew {
                    title = newIssue.title
                }
                lastModelTitle = newIssue.title

                // Impact: raw comparison (no trimming for markdown)
                if impact == lastModelImpact || impact == newIssue.impact {
                    impact = newIssue.impact
                }
                lastModelImpact = newIssue.impact

                // Resolution: normalize empty ↔ nil
                let newRes = newIssue.resolution ?? ""
                let trimmedUIRes = resolution.trimmingCharacters(in: .whitespacesAndNewlines)
                let trimmedLastRes = lastModelResolution.trimmingCharacters(in: .whitespacesAndNewlines)
                let trimmedNewRes = newRes.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmedUIRes == trimmedLastRes || trimmedUIRes == trimmedNewRes {
                    resolution = newRes
                }
                lastModelResolution = newRes
            }
        } else {
            EmptyState(icon: "exclamationmark.triangle", title: "Issue Not Found")
        }
    }

    // MARK: - Title

    private var titleSection: some View {
        VStack(alignment: .leading, spacing: StorySpacing.sm) {
            Text("Title")
                .fabricTypography(.caption)
                .foregroundStyle(FabricColors.inkTertiary)

            FabricTextField(
                placeholder: "Issue title",
                text: $title
            )
            .onChange(of: title) { _, _ in debouncedSave() }
        }
    }

    // MARK: - Impact

    private var impactSection: some View {
        VStack(alignment: .leading, spacing: StorySpacing.sm) {
            HStack {
                Text("Impact")
                    .fabricTypography(.caption)
                    .foregroundStyle(FabricColors.inkTertiary)
                Spacer()
                Button {
                    isPreviewingImpact.toggle()
                } label: {
                    Text(isPreviewingImpact ? "Edit" : "Preview")
                        .fabricTypography(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(FabricColors.inkTertiary)
            }

            if isPreviewingImpact {
                MarkdownPreviewBox(
                    text: impact,
                    placeholder: "No impact description",
                    minHeight: 400
                )
            } else {
                FabricTextEditor(
                    placeholder: "Describe the impact...",
                    text: $impact,
                    minHeight: 400,
                    maxHeight: .infinity
                )
                .onChange(of: impact) { _, _ in debouncedSave() }
            }
        }
    }

    // MARK: - Phase

    private func phaseSection(_ issue: Issue) -> some View {
        VStack(alignment: .leading, spacing: StorySpacing.sm) {
            Text("Phase")
                .fabricTypography(.caption)
                .foregroundStyle(FabricColors.inkTertiary)

            Picker("Phase", selection: phaseBinding(issue)) {
                Text("None").tag(PhaseID?.none)
                ForEach(state.roadmap.phases) { phase in
                    Text("\(phase.label) — \(phase.name)").tag(PhaseID?.some(phase.id))
                }
            }
            .pickerStyle(.menu)
        }
    }

    // MARK: - Severity

    private func severitySection(_ issue: Issue) -> some View {
        VStack(alignment: .leading, spacing: StorySpacing.sm) {
            Text("Severity")
                .fabricTypography(.caption)
                .foregroundStyle(FabricColors.inkTertiary)

            FabricSegmentedControl(
                selection: severityBinding(issue),
                segments: IssueSeverity.allCases.map {
                    .init($0.displayName, value: $0)
                },
                accent: .ochre
            )
        }
    }

    // MARK: - Resolution

    private var resolutionSection: some View {
        VStack(alignment: .leading, spacing: StorySpacing.sm) {
            Text("Resolution")
                .fabricTypography(.caption)
                .foregroundStyle(FabricColors.inkTertiary)

            FabricTextEditor(
                placeholder: "How was this resolved?",
                text: $resolution,
                minHeight: 200,
                maxHeight: 400
            )
            .onChange(of: resolution) { _, _ in debouncedSave() }
        }
    }

    // MARK: - Bindings (instant save)

    private func phaseBinding(_ issue: Issue) -> Binding<PhaseID?> {
        Binding(
            get: { issue.phase },
            set: { newPhase in
                Log.info("IssueInspector: phase → \(newPhase?.rawValue ?? "none") for \(issueID)", tag: "Issues")
                let updated = issue.with(phase: .some(newPhase))
                onUpdateIssue?(updated)
            }
        )
    }

    private func severityBinding(_ issue: Issue) -> Binding<IssueSeverity> {
        Binding(
            get: { issue.severity },
            set: { newSeverity in
                Log.info("IssueInspector: severity → \(newSeverity.displayName) for \(issueID)", tag: "Issues")
                let updated = issue.with(severity: newSeverity)
                onUpdateIssue?(updated)
            }
        )
    }

    // MARK: - Save

    private func debouncedSave() {
        saveTask?.cancel()
        let currentID = issueID
        saveTask = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            guard let issue = state.issue(byID: currentID) else { return }
            let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedResolution = resolution.trimmingCharacters(in: .whitespacesAndNewlines)
            let finalTitle = trimmedTitle.isEmpty ? issue.title : trimmedTitle
            let finalResolution: String?? = trimmedResolution.isEmpty ? .some(nil) : .some(trimmedResolution)
            guard finalTitle != issue.title || impact != issue.impact || trimmedResolution != (issue.resolution ?? "") else { return }
            Log.info("IssueInspector: saving title/impact/resolution for \(currentID)", tag: "Issues")
            let updated = issue.with(title: finalTitle, impact: impact, resolution: finalResolution)
            onUpdateIssue?(updated)
        }
    }
}
