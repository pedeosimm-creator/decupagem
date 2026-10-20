#!/usr/bin/env bash
# Empacota o app num .exe standalone, sem depender do electron-packager
# (a extração de zip dele falha silenciosamente nesta máquina — mesmo bug
# que o instalador do pacote "electron" tem; contornamos copiando o
# binário do Electron já extraído em node_modules/electron/dist).
set -e

cd "$(dirname "$0")/.."

OUT="dist/decupagem-win32-x64"
APP="$OUT/resources/app"

rm -rf dist
mkdir -p "$APP"

cp -r node_modules/electron/dist/. "$OUT/"
mv "$OUT/electron.exe" "$OUT/decupagem.exe"
rm -f "$OUT/resources/default_app.asar"

node scripts/make-icon.js
"./node_modules/rcedit/bin/rcedit-x64.exe" "$OUT/decupagem.exe" \
  --set-icon "assets/icon.ico" \
  --set-version-string "ProductName" "decupagem" \
  --set-version-string "FileDescription" "decupagem"

cp main.js preload.js package.json "$APP/"
cp -r src "$APP/src"
cp -r assets "$APP/assets"
cp -r node_modules "$APP/node_modules"
rm -rf "$APP/node_modules/electron" "$APP/node_modules/.bin"

echo "Pronto: $OUT/decupagem.exe"
