import SwiftUI
import FilmStudioKit

/// One-click tools defined by the server (GET /tools). Every form is rendered from the tool's schema,
/// so new tools ship from the engine without an app update.
struct ToolsView: View {
    @Environment(AppModel.self) private var app
    @State private var state: Loadable<[Tool]> = .loading
    @State private var search = ""

    var body: some View {
        ScreenGate(id: "tools", title: "Tools") {
            Group {
                switch state {
                case .loading: LoadingView(text: "Loading tools…")
                case .unavailable:
                    NotDeployedView(title: "Tools are on their way", systemImage: "square.grid.2x2",
                                    message: "This studio server doesn't offer one-click tools yet. They appear here automatically once the server is updated.",
                                    webPath: app.config.presentation(for: "tools").path) { await load() }
                case .failed(let m): ErrorStateView(message: m) { await load() }
                case .loaded(let tools):
                    let shown = tools.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.description.localizedCaseInsensitiveContains(search) || $0.category.localizedCaseInsensitiveContains(search) }
                    if shown.isEmpty {
                        ContentUnavailableView(search.isEmpty ? "No tools yet" : "No matches", systemImage: "square.grid.2x2")
                    } else {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 22) {
                                ForEach(Tool.grouped(shown), id: \.category) { g in
                                    VStack(alignment: .leading, spacing: 10) {
                                        Text(g.category).font(.title3.weight(.semibold)).padding(.horizontal)
                                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 160, maximum: 280), spacing: 12)], spacing: 12) {
                                            ForEach(g.tools) { t in
                                                NavigationLink { ToolRunView(tool: t) } label: { ToolCard(tool: t) }.buttonStyle(.plain)
                                            }
                                        }
                                        .padding(.horizontal)
                                    }
                                }
                                RunsList(source: nil)
                            }
                            .padding(.vertical)
                        }
                    }
                }
            }
            .navigationTitle("Tools")
            .searchable(text: $search, prompt: "Search tools")
            .refreshable { await load() }
            .task(id: app.refreshTick) { await load() }
            .toolbar {
                ToolbarItem(placement: .trailing) {
                    Menu {
                        Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                        OpenOnWebButton(path: app.config.presentation(for: "tools").path ?? "/", title: "Tools")
                    } label: { Label("More", systemImage: "ellipsis.circle") }
                }
            }
        }
    }

    private func load() async {
        do { state = .loaded(try await app.client.tools()) } catch let e as APIError where e.isMissingRoute {
            state = .unavailable
        } catch is CancellationError {
        } catch {
            if state.value == nil { state = .failed(error.localizedDescription) }
        }
    }
}

private struct ToolCard: View {
    let tool: Tool
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: tool.sfSymbol)
                .font(.title2)
                .foregroundStyle(Color.accentColor)
                .frame(width: 44, height: 44)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            Text(tool.title).font(.headline).lineLimit(1)
            Text(tool.description).font(.caption).foregroundStyle(.secondary).lineLimit(3, reservesSpace: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .contentShape(Rectangle())
    }
}

/// Recent tool runs (all tools, or one).
private struct RunsList: View {
    let source: String?
    @Environment(AppModel.self) private var app
    @State private var open: MediaItem?
    var body: some View {
        let runs = app.generations.runs.filter { r in source.map { r.source == $0 } ?? r.source.hasPrefix("tool:") }
        if !runs.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Recent runs").font(.title3.weight(.semibold))
                ForEach(runs) { r in
                    Button { open = r.resultItem } label: {
                        HStack {
                            if r.isFinished {
                                Image(systemName: r.succeeded ? "checkmark.circle.fill" : "exclamationmark.triangle.fill").foregroundStyle(r.succeeded ? .green : .red)
                            } else { ProgressView().controlSize(.small) }
                            VStack(alignment: .leading) {
                                Text(r.title).font(.subheadline.weight(.medium))
                                Text(r.statusText).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                        }
                        .card(padding: 10)
                    }
                    .buttonStyle(.plain)
                    .disabled(r.resultItem == nil)
                }
            }
            .padding(.horizontal)
            .navigationDestination(item: $open) { MediaViewer(item: $0) }
        }
    }
}

/// Renders any tool's form from its input schema and runs it.
struct ToolRunView: View {
    let tool: Tool
    @Environment(AppModel.self) private var app
    @State private var values: [String: JSONValue] = [:]
    @State private var media: [String: UploadedAsset] = [:]
    @State private var open: MediaItem?
    @State private var started = false

    private var missing: [String] { tool.missingInputs(in: values) }

    var body: some View {
        ScreenGate(id: "tool", params: ["id": tool.id], title: tool.title) {
            Form {
                if !tool.description.isEmpty {
                    Section { Text(tool.description).font(.callout).foregroundStyle(.secondary) }
                }
                ForEach(tool.inputs) { input in
                    Section {
                        ToolInputField(input: input, value: binding(input.key), asset: assetBinding(input))
                    } header: {
                        Text(input.label + (input.required ? " *" : ""))
                    } footer: {
                        if !input.help.isEmpty { Text(input.help) }
                    }
                }
                Section {
                    Button(action: run) {
                        Label("Run \(tool.title)", systemImage: tool.sfSymbol)
                            .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 4)
                    }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
                    .disabled(!missing.isEmpty)
                    .keyboardShortcut(.return, modifiers: .command)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } footer: {
                    if !missing.isEmpty { Text("Needs: \(missing.joined(separator: ", "))") }
                }
                RunsSection(source: "tool:\(tool.id)", open: $open)
            }
            .studioForm()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(tool.title)
            .inlineTitle()
            #if os(iOS)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { hideKeyboard() }
                }
            }
            #endif
            .navigationDestination(item: $open) { MediaViewer(item: $0) }
            .onAppear {
                if !started { values = tool.initialValues; started = true }
            }
            .task {
                if tool.inputs.contains(where: { $0.kind == .model }) { await app.catalogIfNeeded() }
                if tool.inputs.contains(where: { $0.kind == .character }), app.characters.isEmpty { await app.loadCharacters() }
            }
            .onChange(of: app.generations.lastFinished) { _, run in
                if let run, run.source == "tool:\(tool.id)", let item = run.resultItem { open = item }
            }
        }
    }

    private func binding(_ key: String) -> Binding<JSONValue> {
        Binding(get: { values[key] ?? .null }, set: { values[key] = $0 })
    }

    private func assetBinding(_ input: ToolInput) -> Binding<UploadedAsset?> {
        Binding(get: { media[input.key] }, set: { a in
            media[input.key] = a
            values[input.key] = a.map { .string($0.id) } ?? .null
        })
    }

    private func run() {
        let body = values.filter { !$0.value.isNull }
        let client = app.client
        let tool = tool
        // The first text the user typed describes the run best (a prompt or a line); else the tool's description.
        let typed = tool.inputs.first { ($0.kind == .text || $0.kind == .longtext) && (body[$0.key]?.string?.isEmpty == false) }
        let subtitle = typed.flatMap { body[$0.key]?.string } ?? tool.description
        app.generations.start(title: tool.title, subtitle: subtitle, kind: tool.output, source: "tool:\(tool.id)", app: app) {
            try await client.runTool(tool, values: body)
        }
    }
}

/// One input from a tool schema. Unknown types fall back to a text field.
struct ToolInputField: View {
    let input: ToolInput
    @Binding var value: JSONValue
    @Binding var asset: UploadedAsset?
    @Environment(AppModel.self) private var app

    var body: some View {
        switch input.kind {
        case .longtext:
            TextField(input.label, text: text, axis: .vertical).lineLimit(3...10)
        case .number:
            numberField
        case .toggle:
            Toggle(input.label, isOn: Binding(get: { value.bool ?? false }, set: { value = .bool($0) }))
        case .select:
            Picker(input.label, selection: text) {
                if !input.required { Text("—").tag("") }
                ForEach(input.options) { Text($0.label).tag($0.value) }
            }
        case .image:
            MediaSlot(title: input.label, subtitle: input.help, kind: .image, asset: $asset)
        case .video:
            MediaSlot(title: input.label, subtitle: input.help, kind: .video, asset: $asset)
        case .audio:
            MediaSlot(title: input.label, subtitle: input.help, kind: .audio, asset: $asset)
        case .character:
            if app.charactersAvailable == false || app.characters.isEmpty {
                Text(app.charactersAvailable == false ? "Characters aren't available on this server." : "No characters yet — add one in Characters.").foregroundStyle(.secondary)
            } else {
                Picker(input.label, selection: text) {
                    if !input.required { Text("None").tag("") }
                    ForEach(app.characters) { Text($0.name).tag($0.id) }
                }
            }
        case .voice:
            Picker(input.label, selection: text) {
                Text("Default").tag("")
                ForEach(app.sound.allVoices, id: \.voice.id) { pv in
                    Text("\(pv.voice.name) · \(pv.provider.label)").tag(pv.voice.id)
                }
            }
        case .model:
            let kind = input.modelKind ?? "video"
            Picker(input.label, selection: text) {
                if !input.required { Text("Automatic").tag("") }
                ForEach(app.catalog?.groups(kind: kind, hiddenProviders: app.hiddenProviders) ?? [], id: \.provider) { g in
                    Section(g.label) { ForEach(g.models) { Text($0.label).tag($0.id) } }
                }
            }
        default:
            VStack(alignment: .leading, spacing: 4) {
                TextField(input.label, text: text)
                if !input.kind.isKnown { Text("(\(input.kind.rawValue))").font(.caption2).foregroundStyle(.tertiary) }
            }
        }
    }

    private var text: Binding<String> {
        Binding(get: { value.string ?? "" }, set: { value = $0.isEmpty ? .null : .string($0) })
    }

    @ViewBuilder private var numberField: some View {
        let get = { value.double ?? input.min ?? 0 }
        if let lo = input.min, let hi = input.max, hi > lo {
            let step = input.step ?? ((hi - lo) <= 1 ? 0.05 : (hi - lo) <= 20 ? 1 : (hi - lo) / 100)
            LabeledContent(input.label) {
                HStack {
                    Slider(value: Binding(get: get, set: { value = .number(($0 / step).rounded() * step) }), in: lo...hi)
                    Text(get().formatted(.number.precision(.fractionLength(step < 1 ? 2 : 0)))).monospacedDigit().frame(minWidth: 44, alignment: .trailing)
                }
            }
        } else {
            TextField(input.label, value: Binding(get: get, set: { value = .number($0) }), format: .number)
            #if os(iOS)
                .keyboardType(.decimalPad)
            #endif
        }
    }
}
