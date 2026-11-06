import SwiftUI
import FilmStudioKit

/// Who plans the films. There is no default: the user picks, and the server remembers it.
struct DirectorPicker: View {
    @Environment(AppModel.self) private var app
    @State private var saving = false
    @State private var error: String?
    @State private var showChatGPTConnection = false

    var body: some View {
        Group {
            if let cat = app.directors {
                let current = cat.current ?? DirectorChoice(provider: "")
                Picker("Director", selection: Binding(get: { current.isChosen ? current.provider : "" }, set: { choose(DirectorChoice(provider: $0, model: cat.option($0)?.defaultModel ?? "")) })) {
                    if !current.isChosen { Text("Choose…").tag("") }
                    ForEach(cat.options) { o in
                        Text(o.available ? o.label : "\(o.label) — not connected").tag(o.id).disabled(!o.available)
                    }
                    if current.isChosen, cat.option(current.provider) == nil { Text(current.provider).tag(current.provider) }
                }
                if let o = cat.option(current.provider), !o.models.isEmpty {
                    Picker("Model", selection: Binding(get: { current.model }, set: { choose(DirectorChoice(provider: current.provider, model: $0)) })) {
                        Text("Default").tag("")
                        ForEach(o.models) { Text($0.label).tag($0.id) }
                        if !current.model.isEmpty, !o.models.contains(where: { $0.id == current.model }) { Text(current.model).tag(current.model) }
                    }
                }
                if let note = cat.option(current.provider)?.note.nonEmpty {
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
                if !current.isChosen {
                    Label("Pick a director before planning a film.", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.orange)
                }
            } else if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            } else {
                HStack { ProgressView().controlSize(.small); Text("Loading directors…").foregroundStyle(.secondary) }
            }
            Button {
                showChatGPTConnection = true
            } label: {
                Label("ChatGPT / Codex Connection", systemImage: "person.crop.circle.badge.checkmark")
            }
            if saving { HStack { ProgressView().controlSize(.mini); Text("Saving…").font(.caption).foregroundStyle(.secondary) } }
        }
        .task { if app.directors == nil { await load() } }
        .sheet(isPresented: $showChatGPTConnection) { ChatGPTConnectionSheet() }
    }

    private func load() async {
        do { try await app.loadDirectors(); error = nil } catch { self.error = "Couldn't load directors: \(error.localizedDescription)" }
    }

    private func choose(_ c: DirectorChoice) {
        guard c.isChosen else { return }
        saving = true
        Task {
            do { try await app.setDirector(c) } catch {
                self.error = error.localizedDescription
                app.report(error, screen: "director", action: "Choose director")
            }
            saving = false
        }
    }
}

/// Asked before planning when no director has been chosen yet.
struct DirectorSheet: View {
    let onChosen: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Choose who turns your script into scenes and shots. Your choice is remembered for every film until you change it (Settings → Film Director).")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Section("Film director") { DirectorPicker() }
            }
            .studioForm()
            .navigationTitle("Choose a Director")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Plan Film") { dismiss(); onChosen() }
                        .disabled(app.directors?.current?.isChosen != true)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 360)
        #endif
        .presentationDetents([.medium, .large])
    }
}

extension AppModel {
    func loadDirectors() async throws {
        directors = try await client.directors()
    }

    func setDirector(_ choice: DirectorChoice) async throws {
        try await client.setDirector(choice)
        directors?.current = choice
    }
}
