#!/usr/bin/env bash
# Single-host read-only IOC collector template. Edit IOC lists per incident before use.
set -euo pipefail
OUT_DIR="${1:-supply-chain-ioc-evidence-$(hostname)-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT_DIR"
exec > >(tee "$OUT_DIR/collector.log") 2>&1

echo "collector_started_utc=$(date -u +%FT%TZ)"
echo "hostname=$(hostname)"
uname -a || true

cat > "$OUT_DIR/iocs.txt" <<'EOF'
EDIT_ME_malicious_domain_or_string
EOF
cat > "$OUT_DIR/ioc_filenames.txt" <<'EOF'
EDIT_ME_payload.js
EOF

SEARCH_ROOTS=("/home" "/Users" "/root" "/tmp" "/var/tmp" "/opt" "/var/lib/buildkite-agent" "/actions-runner")
EXISTING_ROOTS=()
for r in "${SEARCH_ROOTS[@]}"; do [[ -d "$r" ]] && EXISTING_ROOTS+=("$r"); done
printf '%s\n' "${EXISTING_ROOTS[@]}" > "$OUT_DIR/search_roots.txt"

find "${EXISTING_ROOTS[@]}" -type f \( $(awk '{printf "%s-name %s", NR==1?"":" -o ", $0}' "$OUT_DIR/ioc_filenames.txt") \) -print 2>/dev/null | sort > "$OUT_DIR/ioc_file_paths.txt" || true
while IFS= read -r f; do [[ -f "$f" ]] && (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f" 2>/dev/null || true); done < "$OUT_DIR/ioc_file_paths.txt" > "$OUT_DIR/ioc_file_hashes.sha256"

grep -RIn --binary-files=without-match -f "$OUT_DIR/iocs.txt" "${EXISTING_ROOTS[@]}" 2>/dev/null | head -n 5000 > "$OUT_DIR/ioc_text_hits.txt" || true

find "${EXISTING_ROOTS[@]}" -name .git -type d 2>/dev/null | while read -r g; do
  repo="${g%/.git}"
  # Edit author as needed for the incident.
  git -C "$repo" log --all --author='EDIT_ME_author@example.com' --format='%H %aI %an <%ae> %s' 2>/dev/null | sed "s#^#$repo #"
done | head -n 5000 > "$OUT_DIR/suspicious_git_author_hits.txt" || true

(ps auxww || true) > "$OUT_DIR/ps_auxww.txt"
(ss -tunap || netstat -tunap || true) > "$OUT_DIR/network_sockets.txt" 2>&1

tar -czf "$OUT_DIR.tar.gz" "$OUT_DIR"
(sha256sum "$OUT_DIR.tar.gz" 2>/dev/null || shasum -a 256 "$OUT_DIR.tar.gz") > "$OUT_DIR.tar.gz.sha256"
echo "collector_finished_utc=$(date -u +%FT%TZ)"
echo "evidence_package=$OUT_DIR.tar.gz"
