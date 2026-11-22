#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

cargo build -p zeroledger-ffi

LIB="target/debug/libzeroledger_ffi.so"
if [[ "$(uname -s)" == "Darwin" ]]; then
  LIB="target/debug/libzeroledger_ffi.dylib"
fi

cargo run -p zeroledger-ffi --features cli --bin uniffi-bindgen -- \
  generate --library "$LIB" --language kotlin --out-dir build/uniffi-kotlin
cargo run -p zeroledger-ffi --features cli --bin uniffi-bindgen -- \
  generate --library "$LIB" --language swift --out-dir build/uniffi-swift

mkdir -p mobile/android/app/src/main/java/uniffi/zeroledger_ffi
cp build/uniffi-kotlin/uniffi/zeroledger_ffi/zeroledger_ffi.kt \
  mobile/android/app/src/main/java/uniffi/zeroledger_ffi/

mkdir -p mobile/ios/Generated
cp build/uniffi-swift/zeroledger_ffi.swift mobile/ios/Generated/
cp build/uniffi-swift/zeroledger_ffiFFI.h mobile/ios/Generated/
cp build/uniffi-swift/zeroledger_ffiFFI.modulemap mobile/ios/Generated/

echo "UniFFI bindings generated for Kotlin and Swift."
