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

  jj tag set $tag
  jj describe -m $"Bump to ($tag)"
  jj bookmark set main -r @
  jj new
  jj git push --bookmark main --tag $tag
}
