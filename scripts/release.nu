#!/usr/bin/env nu

def main [] {
  let version_bump_type = [major minor patch] | input list
  if ($version_bump_type | is-empty) {
    print "Skipped"
    return
  }
  npm version $version_bump_type

  jj bookmark advance
  jj git push --all
}
