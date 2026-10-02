SHELL := /bin/sh

.PHONY: help install test clean build-web build-electron build-macos build-windows \
	build-linux build-ios build-android sync-ios sync-android open-ios open-android \
	build-all release

help:
	@echo "Available targets:"
	@echo "  make install         Install project dependencies"
	@echo "  make test            Run the test suite"
	@echo "  make clean           Remove generated build output"
	@echo "  make build-web       Build the static React client"
	@echo "  make build-electron  Build the shared React app and Electron bundles"
	@echo "  make build-macos     Package macOS DMG and ZIP files"
	@echo "  make build-windows   Package a Windows NSIS installer"
	@echo "  make build-linux     Package Linux AppImage and DEB files"
	@echo "  make build-all       Build macOS, Windows, Linux, iOS, and Android"
	@echo "  make release version=1.1.1"
	@echo "                       Tag a version and publish native builds with GitHub Actions"
	@echo "  make sync-ios        Sync the web build into the Capacitor iOS shell"
	@echo "  make sync-android    Sync the web build into the Capacitor Android shell"
	@echo "  make open-ios        Open the iOS project in Xcode"
	@echo "  make open-android    Open the Android project in Android Studio"
	@echo "  make build-ios       Compile an unsigned release iOS app"
	@echo "  make build-android   Compile an unsigned release Android APK"

install:
	npm install

test:
	npm test

clean:
	rm -rf dist dist-electron release

build-web:
	npm run build:web

build-electron:
	npm run build:desktop

build-macos:
	npm run build:macos

build-windows:
	npm run build:windows

build-linux:
	npm run build:linux

build-all: build-macos build-windows build-linux build-ios build-android

release:
	@node scripts/release.mjs "$(version)"

sync-ios:
	npm run prepare:ios

sync-android:
	npm run prepare:android

open-ios:
	npm run cap:open:ios

open-android:
	npm run cap:open:android

build-ios:
	npm run build:ios

build-android:
	npm run build:android
