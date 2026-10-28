#!/bin/sh
set -eu
: "${ACK3_EXPECTED_TREE:?ACK3_EXPECTED_TREE is required}"
: "${ACK3_EXPECTED_COMMIT:?ACK3_EXPECTED_COMMIT is required}"
case "$ACK3_EXPECTED_TREE" in *[!0-9a-f]*|'') echo 'invalid expected Git tree' >&2; exit 2;; esac
case "$ACK3_EXPECTED_COMMIT" in *[!0-9a-f]*|'') echo 'invalid expected Git commit' >&2; exit 2;; esac
test "${#ACK3_EXPECTED_TREE}" -eq 40
test "${#ACK3_EXPECTED_COMMIT}" -eq 40
workspace_root=${ACK3_WORKSPACE_ROOT:-/workspace}
source_owner=${ACK3_SOURCE_OWNER:-10001:10001}
source_dir=$workspace_root/source
private_dir=$workspace_root/private
rm -rf "$source_dir"
install -d -m 0750 "$source_dir"
tar --zstd -xf "$private_dir/source.tar.zst" -C "$source_dir" --no-same-owner
package_manifest=$source_dir/.ack3-source-package.json
test -f "$package_manifest"
jq -e --arg tree "$ACK3_EXPECTED_TREE" --arg commit "$ACK3_EXPECTED_COMMIT" \
  '.schemaVersion == 2 and .tree == $tree and .commit == $commit and (.gitlinks | type == "array") and
   all(.gitlinks[]; (.commit | type == "string") and (.path | type == "string"))' \
  "$package_manifest" >/dev/null
mv "$package_manifest" "$private_dir/source-package.json"
rm -rf "$private_dir/tree-check.git" "$private_dir/tree-check.index"
git init --bare --quiet "$private_dir/tree-check.git"
GIT_DIR="$private_dir/tree-check.git" GIT_WORK_TREE="$source_dir" GIT_INDEX_FILE="$private_dir/tree-check.index" \
  git add --all --force
jq -r '.gitlinks[] | [.commit, .path] | @tsv' "$private_dir/source-package.json" \
  >"$private_dir/source-gitlinks.tsv"
while IFS="$(printf '\t')" read -r gitlink_commit gitlink_path; do
  case "$gitlink_commit" in *[!0-9a-f]*|'') echo 'invalid source gitlink commit' >&2; exit 2;; esac
  test "${#gitlink_commit}" -eq 40
  case "$gitlink_path" in ''|.|..|/*|../*|*/../*|*/..) echo 'invalid source gitlink path' >&2; exit 2;; esac
  test -d "$source_dir/$gitlink_path"
  GIT_DIR="$private_dir/tree-check.git" GIT_WORK_TREE="$source_dir" \
    GIT_INDEX_FILE="$private_dir/tree-check.index" git rm -r --cached -f --quiet -- "$gitlink_path"
  GIT_DIR="$private_dir/tree-check.git" GIT_WORK_TREE="$source_dir" \
    GIT_INDEX_FILE="$private_dir/tree-check.index" git update-index --add --cacheinfo 160000 "$gitlink_commit" "$gitlink_path"
done <"$private_dir/source-gitlinks.tsv"
actual_tree=$(GIT_DIR="$private_dir/tree-check.git" GIT_WORK_TREE="$source_dir" \
  GIT_INDEX_FILE="$private_dir/tree-check.index" git write-tree)
if [ "$actual_tree" != "$ACK3_EXPECTED_TREE" ]; then
  rm -rf "$source_dir" "$private_dir/tree-check.git" "$private_dir/tree-check.index"
  echo "source tree mismatch: expected $ACK3_EXPECTED_TREE, received $actual_tree" >&2
  exit 3
fi
rm -rf "$private_dir/tree-check.git" "$private_dir/tree-check.index"
chown -R "$source_owner" "$source_dir"
