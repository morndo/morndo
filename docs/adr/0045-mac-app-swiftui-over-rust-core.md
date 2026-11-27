# ADR-0045: The Mac app is SwiftUI and AppKit over a Rust core

- **Status:** Accepted, 2026-11-27. The owner chose the toolkit on 27 November ("I want swift ui with rust core
  then."), after a comparison of SwiftUI over a Rust core, Tauri 2 and Rust-native toolkits. The points below that go
  beyond the choice itself are the engineering consequences of it; the build location (Open) is still the owner's.
- **Settles:** the open item "The Mac app's UI toolkit over the Rust core" of ADR-0044 (decision 2).
- **Builds on:** ADR-0044 (the cockpit is the product's UI; Rust types are the source of the API; the Mac app is built
  against the stand-in first), the cockpit API contract (`crates/cockpit-api`, 1.2.0).

## Context

ADR-0044 makes a native Mac app with a Rust core the main client and leaves the UI toolkit to its own ADR. The core
holds the hub client (HTTP and the feed's WebSocket, typed by `crates/cockpit-api`), a local mirror of what the reader
may see, and the terminal stream of a lane (tmux control mode, ADR-0044 decision 6).

Three ways were compared against their official documentation: SwiftUI and AppKit calling the core through UniFFI;
Tauri 2 with the UI in the system WebView, reusing the SvelteKit cockpit; and a Rust-native UI (GPUI, Dioxus). Tauri
would have built the cockpit once for web and Mac. SwiftUI gives the platform's own passkeys, Keychain, panels,
scrolling, accessibility and terminal views directly, and the lowest memory, at the cost of rendering every cockpit view
a second time. The owner chose SwiftUI.

## Decision

1. **SwiftUI for the views, AppKit where SwiftUI falls short.** AppKit is used for: floating or non-activating panels
   (`NSPanel`); long lists such as history and lane trees (`NSTableView`/`NSOutlineView` behind a representable, since
   SwiftUI `List` and `Table` are reported to slow down at scale on macOS); scroll elasticity, so the window and sidebar
   never move ([NSScrollView elasticity](https://developer.apple.com/documentation/appkit/nsscrollview/verticalscrollelasticity));
   and the terminal.
2. **One Rust core, reached through UniFFI.** A crate of its own (`crates/morndo-core`) depends on `crates/cockpit-api`
   and owns networking, the mirror and the terminal model. Swift reaches it through
   [UniFFI](https://github.com/mozilla/uniffi-rs) (0.32.x, proc-macro mode), shipped to Xcode as an XCFramework.
   Contract types cross as UniFFI records, so the Mac app cannot disagree with the hub or the web.
3. **Swift renders; it does not decide.** The hub computes every view per reader (ADR-0044 decision 3); the core adds
   only caching and the mirror. Swift holds no business rules: who may decide is `canDecide`, health is
   `TopicView.health`, and so on. What is built twice, web and Mac, is the rendering, not the rules.
4. **Streams are Rust-owned subscriptions.** The feed and the terminal cross the boundary as a subscription object with
   an explicit `cancel()` and a bounded queue, because UniFFI has no built-in cancellation of async calls
   ([futures](https://mozilla.github.io/uniffi-rs/latest/futures.html)). Backpressure lives in Rust: the terminal sends
   the latest screen state, not every byte.
5. **The terminal is a native view.** [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm) renders the screen model
   the core keeps from tmux control mode. It is tested with VoiceOver like every other view.
6. **Platform services stay on the platform.** Passkeys through AuthenticationServices with the hub's associated domain
   ([supporting passkeys](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys/)); the
   device-bound session token in the Keychain ([Keychain Services](https://developer.apple.com/documentation/security/keychain-services)),
   as ADR-0044 decision 8 asks. The ⌘K palette and the chat float inside the window, as the mockups draw them.
7. **Distribution.** Developer ID signing and notarization through Xcode; updates through
   [Sparkle 2](https://sparkle-project.org/) with a signed feed.
8. **Measured from the first slice.** The first slice (the brief, one lane with a live terminal, the ⌘K palette, against
   the stand-in) sets budgets for cold start, idle and streaming memory, scrolling and terminal throughput, measured with
   Instruments; later slices are held to them.

## Consequences

- Every cockpit view exists twice, in Svelte for the web and in SwiftUI for the Mac. The mockups stay the one visual
  spec, and the contract checks keep both on the same data; a UI promise counts as shipped only when both clients have
  it, or the gap is listed.
- The app needs a Mac to build: Xcode for Swift, and the Rust core compiled for `aarch64-apple-darwin` with Apple's SDK.
  This touches the owner's rule that Rust builds never run on the owner's Mac (see Open).
- A new crate and an FFI layer: UniFFI versions are pinned, and the generated Swift is checked in CI like `generated.ts`.
- CI gains a macOS job for the core, the Swift build and the UI tests.

## Open

- Where the core is built: a GitHub macOS runner producing the XCFramework, or this Mac with release builds only.
- The minimum macOS version, and moving the build Mac from Xcode 26.2 to the current Xcode.
- Where the Sparkle feed is hosted and how it is signed (with the existing release channel or its own).
