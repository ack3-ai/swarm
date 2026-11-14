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
# The package holds each blob's exact bytes: Git attributes in the source must neither change
# bytes nor drop files when the tree is recomputed (tools/publish-source.mjs does the same).
mkdir -p "$private_dir/tree-check.git/info"
printf '%s\n' '* -text -eol -filter -ident -working-tree-encoding -export-ignore -export-subst' \
  >"$private_dir/tree-check.git/info/attributes"
jq -r '.gitlinks[] | [.commit, .path] | @tsv' "$private_dir/source-package.json" \
  >"$private_dir/source-gitlinks.tsv"
# Sets actual_tree to the tree of the unpacked source, each gitlink replaced by its commit.
source_tree() {
  rm -f "$private_dir/tree-check.index"
  GIT_DIR="$private_dir/tree-check.git" GIT_WORK_TREE="$source_dir" GIT_INDEX_FILE="$private_dir/tree-check.index" \
    git -c core.autocrlf=false add --all --force
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
}
source_tree
exact_tree=$actual_tree
if [ "$actual_tree" != "$ACK3_EXPECTED_TREE" ]; then
  # Older source publishers wrote files as the source's Git attributes converted them, and this
  # check applied the same attributes; such a stored package stays usable.
  rm -f "$private_dir/tree-check.git/info/attributes"
  source_tree
fi
if [ "$actual_tree" != "$ACK3_EXPECTED_TREE" ]; then
  rm -rf "$source_dir" "$private_dir/tree-check.git" "$private_dir/tree-check.index"
  echo "source tree mismatch: expected $ACK3_EXPECTED_TREE, received $exact_tree" >&2
  exit 3
fi
rm -rf "$private_dir/tree-check.git" "$private_dir/tree-check.index"
chown -R "$source_owner" "$source_dir"
