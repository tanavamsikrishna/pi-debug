#!/usr/bin/env nu

def main [] {
  let version_bump_type = [patch minor major] | input list
  if ($version_bump_type | is-empty) {
    print "Skipped"
    return
  }
  npm version $version_bump_type --no-git-tag-version

  let new_version = node -p "require('./package.json').version" | str trim
  let tag = $"v($new_version)"
  let current_change_id = jj log --no-pager --no-graph -r @ -T 'change_id' | str trim

  jj describe -m $"Bump to ($tag)" -r $current_change_id
  jj tag set -r $current_change_id $tag
  jj bookmark set main -r $current_change_id
  jj git push --bookmark main --tag $tag
  npm publish --access public
}
