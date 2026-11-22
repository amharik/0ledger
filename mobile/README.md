# 0ledger mobile shells

The mobile apps are **thin native shells over the portable Rust engine**. They do
not re-implement accounting rules, persistence, or sync. Both shells call the
same UniFFI surface exposed by `crates/ffi`.

```
crates/engine   ── pure double-entry rules (no UI, no DB, no network)
crates/storage  ── authoritative SQLite (WAL, migrations, audit chain)
crates/sync     ── sealed device-to-device change envelopes
crates/ffi      ── UniFFI bindings (Kotlin + Swift)
mobile/android  ── Kotlin / Jetpack Compose shell
mobile/ios      ── SwiftUI shell
```

## Generate bindings

```bash
./mobile/generate-bindings.sh
```

This builds `zeroledger-ffi`, runs `uniffi-bindgen`, and copies:

- Kotlin → `mobile/android/app/src/main/java/uniffi/zeroledger_ffi/`
- Swift + headers → `mobile/ios/Generated/`

## Android

Requirements: JDK 17, Android SDK 35, Rust Android targets, `cargo-ndk`.

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
cargo install cargo-ndk
cd mobile/android
# build the native library for each ABI
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -o app/src/main/jniLibs \
  build -p zeroledger-ffi --release
./gradlew :app:assembleDebug
```

The Compose screen opens `filesDir/0ledger.sqlite3`, lists workspaces, and
shows a trial balance computed by the Rust engine.

## iOS

Requirements: Xcode 16+, Rust iOS targets, `xcodegen`.

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
cargo install cargo-xcframework
./mobile/generate-bindings.sh
cd mobile/ios
xcodegen generate
open ZeroLedgerMobile.xcodeproj
```

The SwiftUI screen uses the generated `ZeroLedgerEngine` module and the same
`FfiStore` object as Android and desktop.

## Design rule

Presentation is replaceable. If a future shell needs to be rewritten, the
accounting system, storage, and sync protocol stay untouched.
