# Releases

Use the existing release entry point from a checked-in branch that matches its upstream:

```sh
make release version=dev
make release version=0.4.0
make release version=0.4.0-rc.1
```

`dev` resolves to an ordinary immutable SemVer prerelease, for example `0.3.0-dev.20261004193000`. It does not move an old tag or overwrite a stable release. Each dev release is marked as a GitHub prerelease; the website discovers the newest published dev release and its actual assets. Stable releases remain separate. The two local planning documents are excluded from release cleanliness checks only when untracked; all other source changes must be committed. They are never included by the script.

The script runs tests and the full shared build, updates npm/native versions, increments native build numbers, commits the version, and atomically pushes the branch and tag. iOS keeps a numeric marketing version. GitHub Actions verifies the core and SDK, builds all platforms, verifies the container, and publishes a release only after all jobs succeed. Check progress with `gh run list --workflow release.yml`. A failed run can be rerun, or dispatched with its existing tag. Publication uses a draft until all downloads and checksums are uploaded.

## Downloads

- macOS arm64 and x64: DMG and ZIP. These development builds are not notarized or publisher-signed.
- Windows x64: NSIS installer, without a publisher signing certificate.
- Linux x64 and arm64: AppImage and DEB.
- Android dev: an installable APK signed with the persistent development key. Stable/other prereleases currently produce an explicitly named unsigned APK that needs signing.
- iOS: an unsigned device app archive requiring Apple signing and provisioning; an arm64 simulator archive for Xcode on Apple Silicon. These are not TestFlight/App Store releases.
- Web: a static bundle with the complete Office runtime and hosting instructions.
- Server: a standalone Compose file pinned to the released amd64/arm64 GHCR image. It defaults to storage-only, with the UI disabled. It does not require a repository checkout or local image build.

Every release includes `SHA256SUMS.txt`. Development builds use the same application IDs; export your workspaces before switching builds. Native platform limitations still apply, including WebView support for Office's WebAssembly threads and direct file access.

For public Docker downloads, a package administrator must set the `taskasaur` container package's visibility to **Public** in GitHub Package settings. A public source repository does not guarantee anonymous access to its container package. Verify a pull without registry credentials before announcing the Compose download as publicly usable; private packages require a login with package-read access.

If only publication failed, dispatch the Release workflow on `main` with its original `tag` and `artifact_run_id`. This reuses the successful build artifacts after checking the source run's commit against the tag and requiring every build, verification, and container publication job to have passed. It does not move the tag or rebuild binaries. Distribution artifacts are selected explicitly; Docker build records remain attached to CI rather than shipped as downloads.

## Android development signing

Repository Actions secrets `TASKASAUR_DEV_ANDROID_KEYSTORE` (base64-encoded JKS) and `TASKASAUR_DEV_ANDROID_PASSWORD` hold a dedicated development key with alias `taskasaur-dev`. The key is deliberately separate from future production signing. Keep the same key across dev releases so Android permits updates. Never commit signing keys. The workflow fails if a dev key is missing rather than publishing an un-installable APK labeled as installable.

To configure your own repository, generate a key with `keytool`, then use `gh secret set` to supply those two secrets through stdin. Use password files/environment options rather than logging credentials in command arguments.

## Website

The independent `taskasaur/website` repository serves the public marketing site. Its Downloads section calls the public GitHub Releases API, selects the newest completed development prerelease, and maps asset suffixes from `artifactName` / the release workflow. A short local session cache reduces API requests. With JavaScript disabled or the API unavailable, links still lead to the GitHub releases list. No key or token is placed in the website.
