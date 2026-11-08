#!/usr/bin/env bash
# Signs native artifacts with a stable identity so macOS TCC consents (Screen Recording,
# Accessibility, AppleEvents) survive rebuilds. Ad-hoc signing changes the cdhash every build,
# and macOS then treats the rebuilt helper as a different app: every grant resets, every app
# re-prompts, and the supervisor's permission probe restarts the child. A stable identity
# fixes that. Fallback is ad-hoc with a loud warning so builds never hard-fail on a machine
# without the identity.
#
#   scripts/sign-native.sh <path> [more paths...]
#
# Env:
#   OPENCUA_CODESIGN_ID          identity name (default: "opencua dev")
#   OPENCUA_CODESIGN_KEYCHAIN    keychain path (default: <repo>/.signing/opencua-signing.keychain-db)
#   OPENCUA_CODESIGN_IDENTIFIER  code-signing identifier to stamp with --identifier. Set this to the
#                                  opencua-mcp bundle id (dev.opencua.mcp) for a standalone helper that
#                                  must share the MCP app's TCC grant (Accessibility, Input Monitoring)
#                                  instead of appearing as its own entry in System Settings > Privacy.
set -euo pipefail

identity="${OPENCUA_CODESIGN_ID:-opencua dev}"
identifier="${OPENCUA_CODESIGN_IDENTIFIER:-}"
identifier_args=()
if [[ -n "$identifier" ]]; then
	identifier_args=(--identifier "$identifier")
fi
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
keychain="${OPENCUA_CODESIGN_KEYCHAIN:-$repo/.signing/opencua-signing.keychain-db}"
keychain_password="opencua-local-signing"
# Keychains created before the OpenCUA rename keep their original file name, password and identity name.
legacy_keychain="$repo/.signing/apple-cua-signing.keychain-db"
if [[ -z "${OPENCUA_CODESIGN_KEYCHAIN:-}" && ! -f "$keychain" && -f "$legacy_keychain" ]]; then
	keychain="$legacy_keychain"
	keychain_password="apple-cua-local-signing"
	identity="${OPENCUA_CODESIGN_ID:-apple-cua dev}"
fi

if [[ ! -f "$keychain" ]]; then
	echo "sign-native: no signing keychain at $keychain; falling back to ad-hoc (TCC grants will reset on every rebuild)" >&2
	identity="-"
	keychain=""
fi

if [[ "$identity" != "-" ]] && ! security unlock-keychain -p "$keychain_password" "$keychain"; then
	echo "sign-native: $keychain does not unlock, so nothing can be signed as \"$identity\". Repair it, keeping the same identity and its permission grants: $repo/scripts/create-signing-identity.sh --repair" >&2
	exit 1
fi

for path in "$@"; do
	if [[ "$identity" == "-" ]]; then
		codesign --force --sign - ${identifier_args[@]+"${identifier_args[@]}"} "$path"
	else
		codesign --force --sign "$identity" --keychain "$keychain" ${identifier_args[@]+"${identifier_args[@]}"} "$path"
	fi
done
