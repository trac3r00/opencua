#!/usr/bin/env bash
# Creates the dedicated signing keychain + self-signed code-signing identity for opencua.
#
#   scripts/create-signing-identity.sh            create a new identity next to this script. A new certificate is a
#                                                 new code identity: macOS asks for every permission again.
#   scripts/create-signing-identity.sh --repair   rebuild <repo>/.signing's keychain from the certificate and key kept
#                                                 beside it, for a keychain that no longer unlocks. The certificate
#                                                 stays the same, so the helper's identity and its permission grants do.
#
# Run once per machine. The private key never leaves the .signing directory.
set -euo pipefail

if [[ "${1:-}" == "--repair" ]]; then
	signing="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.signing"
	# Identities created before the OpenCUA rename keep their original file names, password and name.
	name=opencua
	[[ -f "$signing/opencua-signing.key" ]] || name=apple-cua
	key="$signing/$name-signing.key"
	crt="$signing/$name-signing.crt"
	KC="$signing/$name-signing.keychain-db"
	PASS="$name-local-signing"
	for file in "$key" "$crt"; do
		if [[ ! -f "$file" ]]; then
			echo "repair: missing $file; without the old key and certificate the identity cannot be kept" >&2
			echo "        create a new one with: $0 (macOS then asks for every permission again)" >&2
			exit 1
		fi
	done
	if security unlock-keychain -p "$PASS" "$KC" 2>/dev/null &&
		security find-identity -p codesigning -v "$KC" | grep -q "\"$name dev\""; then
		echo "repair: $KC unlocks and holds \"$name dev\"; nothing to repair"
		exit 0
	fi
	if [[ -f "$KC" ]]; then
		backup="$KC.bak-$(date +%Y%m%d%H%M%S)"
		mv "$KC" "$backup"
		echo "repair: moved the keychain that does not unlock to $backup"
	fi
	security create-keychain -p "$PASS" "$KC"
	security set-keychain-settings "$KC"
	security unlock-keychain -p "$PASS" "$KC"
	security import "$key" -k "$KC" -T /usr/bin/codesign -P ""
	security import "$crt" -k "$KC" -T /usr/bin/codesign
	security set-key-partition-list -S apple-tool:,apple: -s -k "$PASS" "$KC" >/dev/null
	# The trust setting belongs to the certificate, not the keychain, so it usually survives; set it only when lost.
	if ! security find-identity -p codesigning -v "$KC" | grep -q "\"$name dev\""; then
		security add-trusted-cert -r trustRoot -k "$KC" "$crt"
	fi
	security find-identity -p codesigning -v "$KC"
	echo "repair: $KC holds \"$name dev\" again ($(openssl x509 -in "$crt" -noout -fingerprint -sha1))"
	exit 0
fi

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KC="$dir/opencua-signing.keychain-db"
PASS="opencua-local-signing"
openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
	-subj "/CN=opencua dev/O=opencua local" \
	-addext "keyUsage=digitalSignature" \
	-addext "extendedKeyUsage=codeSigning" \
	-keyout "$dir/signing.key" -out "$dir/signing.crt"
openssl pkcs12 -export -legacy -out "$dir/signing.p12" -inkey "$dir/signing.key" -in "$dir/signing.crt" -passout "pass:$PASS"
security create-keychain -p "$PASS" "$KC" 2>/dev/null || true
security import "$dir/signing.key" -k "$KC" -T /usr/bin/codesign -P ""
security import "$dir/signing.crt" -k "$KC" -T /usr/bin/codesign
security add-trusted-cert -r trustRoot -k "$KC" "$dir/signing.crt"
security set-key-partition-list -S apple-tool:,apple: -s -k "$PASS" "$KC" >/dev/null
security find-identity -p codesigning -v "$KC"
echo "identity ready; sign with OPENCUA_CODESIGN_ID='opencua dev' OPENCUA_CODESIGN_KEYCHAIN=$KC"
