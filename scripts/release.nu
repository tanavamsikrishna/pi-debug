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
  let current_change_id = jj show --no-patch -T 'self.change_id()' | str trim

  jj tag set $tag -r $current_change_id
  jj describe -m $"Bump to ($tag)" -r $current_change_id --ignore-immutable
  jj bookmark set main -r $current_change_id
  jj git push --bookmark main --tag $tag
}
