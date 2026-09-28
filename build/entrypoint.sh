#!/bin/sh
# Point d'entrée du service `builder` : installe la seule dépendance du
# script de build, puis lui transmet les arguments reçus.
set -e
pip install --quiet --disable-pip-version-check --root-user-action=ignore pyyaml
exec python build/build.py "$@"
