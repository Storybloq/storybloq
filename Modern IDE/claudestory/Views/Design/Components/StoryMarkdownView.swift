import SwiftUI
import Markdown
import Fabric

// MARK: - Story Markdown View

/// Renders a markdown string as formatted SwiftUI views.
/// Supports headings, lists, code blocks, blockquotes, and inline formatting.
/// Uses Apple's swift-markdown parser for block structure,
/// and Foundation's AttributedString(markdown:) for inline formatting within each block.
struct StoryMarkdownView: View {
    let content: String

    init(_ content: String) {
        self.content = content
        let parsed = Self.parse(content)
        Log.debug("init — content length: \(content.count), produced \(parsed.count) blocks", tag: "Markdown")
        _blocks = State(initialValue: parsed)
    }

    @State private var blocks: [RenderedBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: StorySpacing.sm) {
            ForEach(blocks) { block in
                block.view
            }
        }
        .onChange(of: content) { _, new in
            Log.debug("onChange — content changed to \(new.count) chars", tag: "Markdown")
            blocks = Self.parse(new)
        }
    }

    /// Strips markdown syntax and returns clean plain text for previews (e.g., kanban cards).
    static func plainText(from content: String) -> String {
        let unescaped = content
            .replacingOccurrences(of: "\\n", with: "\n")
            .replacingOccurrences(of: "\\\"", with: "\"")
        let cleaned = stripWrappingCodeFence(unescaped)
        let document = Document(parsing: cleaned)
        // Walk the AST and collect text from all inline leaves
        var collector = PlainTextCollector()
        collector.visit(document)
        return collector.result
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func parse(_ content: String) -> [RenderedBlock] {
        let unescaped = content
            .replacingOccurrences(of: "\\n", with: "\n")
            .replacingOccurrences(of: "\\\"", with: "\"")
        let cleaned = stripWrappingCodeFence(unescaped)
        let preview = cleaned.prefix(80).replacingOccurrences(of: "\n", with: "\\n")
        Log.debug("parse — input: \"\(preview)...\"", tag: "Markdown")
        let document = Document(parsing: cleaned)
        var visitor = StoryMarkupVisitor()
        let nodes = visitor.visitDocument(document)
        Log.debug("parse — produced \(nodes.count) blocks", tag: "Markdown")
        return nodes
    }

    /// If the entire content is wrapped in a single code fence (any number of backticks),
    /// strip the opening and closing fences so the inner markdown renders normally.
    private static func stripWrappingCodeFence(_ content: String) -> String {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("```") else { return content }

        // Count opening backticks
        let backtickCount = trimmed.prefix(while: { $0 == "`" }).count
        let fence = String(repeating: "`", count: backtickCount)

        // Find end of opening fence line
        guard let firstNewline = trimmed.firstIndex(of: "\n") else { return content }
        let afterOpening = trimmed[trimmed.index(after: firstNewline)...]

        // Check if content ends with the same fence
        guard trimmed.hasSuffix(fence) else { return content }

        // Strip the closing fence
        let beforeClosing = afterOpening.dropLast(backtickCount)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        // Only strip if there are no other fences of the same length inside
        if beforeClosing.contains(fence) { return content }

        Log.debug("stripWrappingCodeFence — stripped outer \(backtickCount)-backtick fence", tag: "Markdown")
        return beforeClosing
    }
}

// MARK: - Rendered Block

private struct RenderedBlock: Identifiable {
    let id: Int
    let view: AnyView
}

// MARK: - Inline Text Rendering

/// Renders a markdown string fragment as a Text view using Foundation's parser.
/// This gives us bold, italic, strikethrough, inline code, and links for free
/// without manually composing AttributedString runs.
private struct InlineMarkdownText: View {
    let source: String
    let foregroundColor: Color

    init(_ source: String, foreground: Color = StoryTheme.textSecondary) {
        self.source = source
        self.foregroundColor = foreground
    }

    var body: some View {
        let _ = Log.debug("InlineMarkdownText — source: \"\(source.prefix(60))\"", tag: "Markdown")
        if let attributed = try? AttributedString(
            markdown: source,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            let _ = Log.debug("InlineMarkdownText — parsed OK, \(attributed.characters.count) chars", tag: "Markdown")
            Text(filterLinks(attributed))
                .foregroundStyle(foregroundColor)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            let _ = Log.warning("InlineMarkdownText — parse FAILED, falling back to plain text", tag: "Markdown")
            Text(source)
                .foregroundStyle(foregroundColor)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Filter link URLs to only allow safe schemes.
    private func filterLinks(_ attr: AttributedString) -> AttributedString {
        var result = attr
        for run in attr.runs {
            if let url = run.link {
                let scheme = url.scheme?.lowercased() ?? ""
                if !["http", "https", "mailto"].contains(scheme) {
                    result[run.range].link = nil
                }
            }
        }
        return result
    }
}

// MARK: - Markup Visitor

/// Walks the swift-markdown AST and produces block-level RenderedBlock views.
/// Inline formatting is delegated to Foundation's AttributedString(markdown:)
/// by reconstructing the source markdown for each block's inline content.
private struct StoryMarkupVisitor {
    private var blockIndex = 0

    private mutating func nextID() -> Int {
        let id = blockIndex
        blockIndex += 1
        return id
    }

    mutating func visitDocument(_ document: Document) -> [RenderedBlock] {
        let childCount = document.childCount
        Log.debug("visitDocument — \(childCount) children", tag: "Markdown")
        var blocks: [RenderedBlock] = []
        for (i, child) in document.children.enumerated() {
            let typeName = String(describing: type(of: child))
            Log.debug("  child[\(i)] type: \(typeName)", tag: "Markdown")
            let childBlocks = visitBlock(child)
            Log.debug("  child[\(i)] produced \(childBlocks.count) blocks", tag: "Markdown")
            blocks.append(contentsOf: childBlocks)
        }
        return blocks
    }

    // MARK: Block Dispatch

    private mutating func visitBlock(_ markup: any Markup) -> [RenderedBlock] {
        let typeName = String(describing: type(of: markup))
        if let paragraph = markup as? Paragraph {
            let source = inlineSource(from: paragraph)
            Log.debug("    visitParagraph — source: \"\(source.prefix(60))\"", tag: "Markdown")
            return visitParagraph(paragraph)
        } else if let heading = markup as? Heading {
            Log.debug("    visitHeading — level \(heading.level)", tag: "Markdown")
            return visitHeading(heading)
        } else if let list = markup as? UnorderedList {
            Log.debug("    visitUnorderedList — \(list.childCount) items", tag: "Markdown")
            return visitUnorderedList(list)
        } else if let list = markup as? OrderedList {
            Log.debug("    visitOrderedList — \(list.childCount) items", tag: "Markdown")
            return visitOrderedList(list)
        } else if let codeBlock = markup as? CodeBlock {
            Log.debug("    visitCodeBlock — lang: \(codeBlock.language ?? "none"), \(codeBlock.code.count) chars", tag: "Markdown")
            return visitCodeBlock(codeBlock)
        } else if let blockQuote = markup as? BlockQuote {
            Log.debug("    visitBlockQuote — \(blockQuote.childCount) children", tag: "Markdown")
            return visitBlockQuote(blockQuote)
        } else if markup is ThematicBreak {
            Log.debug("    visitThematicBreak", tag: "Markdown")
            return [RenderedBlock(id: nextID(), view: AnyView(Divider()))]
        } else if let table = markup as? Markdown.Table {
            Log.debug("    visitTable", tag: "Markdown")
            return visitTable(table)
        } else if let html = markup as? HTMLBlock {
            Log.debug("    visitHTMLBlock — \(html.rawHTML.count) chars", tag: "Markdown")
            return [RenderedBlock(id: nextID(), view: AnyView(
                Text(verbatim: html.rawHTML)
                    .fabricTypography(.mono)
                    .foregroundStyle(StoryTheme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            ))]
        } else {
            let source = inlineSource(from: markup)
            Log.warning("    visitBlock UNKNOWN type: \(typeName), source: \"\(source.prefix(40))\"", tag: "Markdown")
            if source.isEmpty { return [] }
            return [RenderedBlock(id: nextID(), view: AnyView(
                InlineMarkdownText(source)
            ))]
        }
    }

    // MARK: Block Elements

    private mutating func visitParagraph(_ paragraph: Paragraph) -> [RenderedBlock] {
        let source = inlineSource(from: paragraph)
        return [RenderedBlock(id: nextID(), view: AnyView(
            InlineMarkdownText(source)
        ))]
    }

    private mutating func visitHeading(_ heading: Heading) -> [RenderedBlock] {
        let source = inlineSource(from: heading)
        let level = heading.level
        return [RenderedBlock(id: nextID(), view: AnyView(
            HeadingView(source: source, level: level)
        ))]
    }

    private mutating func visitUnorderedList(_ list: UnorderedList) -> [RenderedBlock] {
        var items: [ListItemData] = []
        for child in list.children {
            if let listItem = child as? ListItem {
                items.append(ListItemData(blocks: visitListItemContent(listItem)))
            }
        }
        return [RenderedBlock(id: nextID(), view: AnyView(
            UnorderedListView(items: items, depth: listDepth(list))
        ))]
    }

    private mutating func visitOrderedList(_ list: OrderedList) -> [RenderedBlock] {
        var items: [ListItemData] = []
        for child in list.children {
            if let listItem = child as? ListItem {
                items.append(ListItemData(blocks: visitListItemContent(listItem)))
            }
        }
        return [RenderedBlock(id: nextID(), view: AnyView(
            OrderedListView(items: items, startIndex: Int(list.startIndex), depth: listDepth(list))
        ))]
    }

    private mutating func visitCodeBlock(_ codeBlock: CodeBlock) -> [RenderedBlock] {
        [RenderedBlock(id: nextID(), view: AnyView(
            CodeBlockView(code: codeBlock.code, language: codeBlock.language)
        ))]
    }

    private mutating func visitBlockQuote(_ blockQuote: BlockQuote) -> [RenderedBlock] {
        var innerBlocks: [RenderedBlock] = []
        for child in blockQuote.children {
            innerBlocks.append(contentsOf: visitBlock(child))
        }
        return [RenderedBlock(id: nextID(), view: AnyView(
            BlockQuoteView(blocks: innerBlocks)
        ))]
    }

    private mutating func visitTable(_ table: Markdown.Table) -> [RenderedBlock] {
        // Render table as readable text: cells joined by " | ", rows by newlines
        var rows: [String] = []

        // Header
        let headerCells = table.head.cells.map { $0.plainText }
        rows.append(headerCells.joined(separator: " | "))
        rows.append(String(repeating: "—", count: max(rows.first?.count ?? 10, 10)))

        // Body rows
        for row in table.body.rows {
            let cells = row.cells.map { $0.plainText }
            rows.append(cells.joined(separator: " | "))
        }

        let tableText = rows.joined(separator: "\n")
        return [RenderedBlock(id: nextID(), view: AnyView(
            Text(verbatim: tableText)
                .fabricTypography(.mono)
                .foregroundStyle(StoryTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        ))]
    }

    // MARK: List Item Content

    private mutating func visitListItemContent(_ listItem: ListItem) -> [RenderedBlock] {
        var blocks: [RenderedBlock] = []
        for child in listItem.children {
            blocks.append(contentsOf: visitBlock(child))
        }
        return blocks
    }

    // MARK: Helpers

    /// Extracts the original markdown source for a block's inline content.
    /// This preserves **bold**, *italic*, `code`, [links](url), etc.
    /// so Foundation's parser can render them correctly.
    private func inlineSource(from markup: any Markup) -> String {
        var formatter = MarkupFormatter()
        for child in markup.children {
            formatter.visit(child)
        }
        return formatter.result
    }

    private func listDepth(_ node: any Markup) -> Int {
        var depth = 0
        var current: (any Markup)? = node.parent
        while let p = current {
            if p is UnorderedList || p is OrderedList {
                depth += 1
            }
            current = p.parent
        }
        return depth
    }
}

// MARK: - Block Views

private struct HeadingView: View {
    let source: String
    let level: Int

    var body: some View {
        InlineMarkdownText(source, foreground: StoryTheme.textPrimary)
            .modifier(headingStyle)
    }

    private var headingStyle: some ViewModifier {
        switch level {
        case 1: return FabricTypographyModifier(style: .heading)
        case 2: return FabricTypographyModifier(style: .label)
        default: return FabricTypographyModifier(style: .body)
        }
    }
}

private struct ListItemData: Identifiable {
    let id = UUID()
    let blocks: [RenderedBlock]
}

private struct UnorderedListView: View {
    let items: [ListItemData]
    let depth: Int

    var body: some View {
        VStack(alignment: .leading, spacing: StorySpacing.xs) {
            ForEach(items) { item in
                HStack(alignment: .firstTextBaseline, spacing: StorySpacing.xs) {
                    Text(bullet)
                        .foregroundStyle(StoryTheme.textTertiary)
                        .frame(width: 16, alignment: .center)
                    VStack(alignment: .leading, spacing: StorySpacing.xs) {
                        ForEach(item.blocks) { block in
                            block.view
                        }
                    }
                }
            }
        }
        .padding(.leading, depth > 0 ? StorySpacing.md : 0)
    }

    private var bullet: String {
        switch depth {
        case 0: return "\u{2022}"  // bullet
        case 1: return "\u{25E6}"  // circle
        default: return "\u{2023}" // triangle
        }
    }
}

private struct OrderedListView: View {
    let items: [ListItemData]
    let startIndex: Int
    let depth: Int

    var body: some View {
        VStack(alignment: .leading, spacing: StorySpacing.xs) {
            ForEach(Array(items.enumerated()), id: \.element.id) { offset, item in
                HStack(alignment: .firstTextBaseline, spacing: StorySpacing.xs) {
                    Text("\(startIndex + offset).")
                        .foregroundStyle(StoryTheme.textTertiary)
                        .monospacedDigit()
                        .frame(width: 24, alignment: .trailing)
                    VStack(alignment: .leading, spacing: StorySpacing.xs) {
                        ForEach(item.blocks) { block in
                            block.view
                        }
                    }
                }
            }
        }
        .padding(.leading, depth > 0 ? StorySpacing.md : 0)
    }
}

private struct CodeBlockView: View {
    let code: String
    let language: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language {
                Text(language.lowercased())
                    .fabricTypography(.caption)
                    .foregroundStyle(StoryTheme.textTertiary)
                    .padding(.horizontal, StorySpacing.sm)
                    .padding(.top, StorySpacing.xs)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(verbatim: code.hasSuffix("\n") ? String(code.dropLast()) : code)
                    .fabricTypography(.mono)
                    .foregroundStyle(StoryTheme.textPrimary)
                    .padding(StorySpacing.sm)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StoryTheme.surfaceAlt)
        .clipShape(RoundedRectangle(cornerRadius: FabricSpacing.radiusMd, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: FabricSpacing.radiusMd, style: .continuous)
                .stroke(StoryTheme.border, lineWidth: 0.5)
        }
    }
}

private struct BlockQuoteView: View {
    let blocks: [RenderedBlock]

    var body: some View {
        HStack(spacing: 0) {
            RoundedRectangle(cornerRadius: 2)
                .fill(StoryTheme.accent)
                .frame(width: 4)
            VStack(alignment: .leading, spacing: StorySpacing.xs) {
                ForEach(blocks) { block in
                    block.view
                }
            }
            .padding(.leading, StorySpacing.sm)
            .padding(.vertical, StorySpacing.xs)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, StorySpacing.xs)
        .background(StoryTheme.accentGlow)
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
    }
}

// MARK: - Plain Text Collector

/// Walks the markdown AST and collects plain text from all inline leaves.
private struct PlainTextCollector: MarkupWalker {
    var result = ""

    mutating func visitText(_ text: Markdown.Text) {
        result += text.plainText
    }

    mutating func visitSoftBreak(_ softBreak: SoftBreak) {
        result += " "
    }

    mutating func visitLineBreak(_ lineBreak: LineBreak) {
        result += " "
    }

    mutating func visitInlineCode(_ inlineCode: InlineCode) {
        result += inlineCode.code
    }
}

// MARK: - Preview

#Preview("StoryMarkdownView") {
    ScrollView {
        StoryMarkdownView("""
        # Heading 1

        ## Heading 2

        ### Heading 3

        Regular paragraph with **bold**, *italic*, and `inline code`. Also ~~strikethrough~~ text.

        A paragraph with **bold *and italic*** nested together.

        - Bullet one
        - Bullet two with **bold**
          - Nested bullet
          - Another nested
            - Deep nested

        1. First item
        2. Second item
        3. Third item

        ```swift
        let greeting = "Hello, world!"
        print(greeting)
        ```

        > A blockquote with **bold** and *italic* text.
        > Second line of the quote.

        ---

        A [safe link](https://example.com) and a [blocked link](javascript:alert(1)) in text.

        Plain text without any markdown renders as a normal paragraph.
        """)
        .padding(StorySpacing.lg)
    }
    .frame(width: 500, height: 800)
    .background(StoryTheme.base)
}
