#!/usr/bin/env bash
# Creates the dedicated signing keychain + self-signed code-signing identity for opencua.
#
#   scripts/create-signing-identity.sh            create a new identity in <repo>/.signing. A new certificate is a new
#                                                 code identity: macOS asks for every permission again.
#   scripts/create-signing-identity.sh --repair   rebuild <repo>/.signing's keychain from the certificate and key kept
#                                                 beside it, for a keychain that no longer unlocks. The certificate
#                                                 stays the same, so the helper's identity and its permission grants do.
#
# Run once per machine. The private key never leaves <repo>/.signing, which git ignores.
set -euo pipefail

signing="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.signing"

if [[ "${1:-}" == "--repair" ]]; then
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
	if ! security find-identity -p codesigning -v "$KC" | grep -q "\"$name dev\""; then
		echo "repair: $KC still has no valid \"$name dev\" identity; check that $key and $crt belong together" >&2
		exit 1
	fi
	echo "repair: $KC holds \"$name dev\" again ($(openssl x509 -in "$crt" -noout -fingerprint -sha1))"
	exit 0
fi

mkdir -p "$signing"
KC="$signing/opencua-signing.keychain-db"
PASS="opencua-local-signing"
openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
	-subj "/CN=opencua dev/O=opencua local" \
	-addext "keyUsage=digitalSignature" \
	-addext "extendedKeyUsage=codeSigning" \
	-keyout "$signing/opencua-signing.key" -out "$signing/opencua-signing.crt"
chmod 600 "$signing/opencua-signing.key"
openssl pkcs12 -export -legacy -out "$signing/opencua-signing.p12" -inkey "$signing/opencua-signing.key" \
	-in "$signing/opencua-signing.crt" -passout "pass:$PASS"
security create-keychain -p "$PASS" "$KC" 2>/dev/null || true
security import "$signing/opencua-signing.key" -k "$KC" -T /usr/bin/codesign -P ""
security import "$signing/opencua-signing.crt" -k "$KC" -T /usr/bin/codesign
security add-trusted-cert -r trustRoot -k "$KC" "$signing/opencua-signing.crt"
security set-key-partition-list -S apple-tool:,apple: -s -k "$PASS" "$KC" >/dev/null
security find-identity -p codesigning -v "$KC"
echo "identity ready in $KC; sign-native.sh and build-tcc-helper.sh use it from now on"
