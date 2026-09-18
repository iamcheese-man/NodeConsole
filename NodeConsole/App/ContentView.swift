import SwiftUI

struct ContentView: View {
    @StateObject private var vm = ConsoleViewModel()
    @FocusState private var inputFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                scrollback
                Divider()
                historyBar
                inputBar
            }
            .navigationTitle("Node Console")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    statusDot
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Clear screen") { vm.input = ".clear"; vm.run() }
                        Button("Reset context", role: .destructive) { vm.reset() }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .background(Color.black.ignoresSafeArea())
        }
        .preferredColorScheme(.dark)
    }

    private var statusDot: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(vm.isReady ? Color.green : Color.orange)
                .frame(width: 8, height: 8)
            Text(vm.isReady ? "node ready" : "starting…")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var scrollback: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(vm.lines) { line in
                        Text(line.text)
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(color(for: line.kind))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .id(line.id)
                    }
                    if vm.isBusy {
                        HStack(spacing: 6) {
                            ProgressView().scaleEffect(0.7)
                            Text("running…").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(12)
            }
            .onChange(of: vm.lines.count) { _, _ in
                if let last = vm.lines.last?.id {
                    withAnimation { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
        }
    }

    private var historyBar: some View {
        HStack(spacing: 16) {
            Button { vm.historyUp() } label: { Image(systemName: "chevron.up") }
            Button { vm.historyDown() } label: { Image(systemName: "chevron.down") }
            Spacer()
            Text(".clear wipes the screen · Reset (⋯) wipes variables")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(white: 0.08))
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Text(">")
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(.green)

            TextField("JavaScript…", text: $vm.input, axis: .vertical)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(.white)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($inputFocused)
                .lineLimit(1...6)
                .onSubmit { vm.run() }
                .submitLabel(.send)

            Button {
                vm.run()
            } label: {
                Image(systemName: "paperplane.fill")
            }
            .disabled(!vm.isReady || vm.isBusy || vm.input.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(12)
        .background(Color(white: 0.1))
    }

    private func color(for kind: ConsoleLine.Kind) -> Color {
        switch kind {
        case .input: return .cyan
        case .output: return .white
        case .error: return .red
        case .system: return .gray
        }
    }
}

#Preview {
    ContentView()
}
