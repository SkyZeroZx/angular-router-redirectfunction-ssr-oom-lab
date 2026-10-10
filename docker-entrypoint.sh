#!/bin/sh
# ROUTER_FIX picks the build: off is stock @angular/router, on has scripts/router-fix.mjs applied.
# Arguments are node flags, such as --max-old-space-size.
set -eu
case "${ROUTER_FIX:-off}" in
  off) dist=dist/angular-router-redirectfunction-ssr-oom-lab ;;
  on) dist=dist/angular-router-redirectfunction-ssr-oom-lab-fixed ;;
  *) echo "ROUTER_FIX must be on or off, got: $ROUTER_FIX" >&2; exit 64 ;;
esac
echo "Router fix ${ROUTER_FIX:-off}: $dist"
exec node "$@" "$dist/server/server.mjs"
