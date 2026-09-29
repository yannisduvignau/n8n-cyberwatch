#!/bin/sh
# Entry point of the `builder` service: installs the build script's only
# dependency, then passes it the arguments received.
set -e
pip install --quiet --disable-pip-version-check --root-user-action=ignore pyyaml
exec python build/build.py "$@"
