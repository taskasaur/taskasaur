# Remote terminal

The optional `remote-terminal` plugin uses MIT-licensed `ssh2`, `node-pty`, `@xterm/xterm`, and `ws`. Core owns device identity, presence and streaming. Controllers use the shared UI; eligible native computers explicitly opt into hosting a shell. Browser/iOS/Android clients can control a linked host without hosting a shell themselves.

The native host initiates an outbound WSS connection, so it does not need an inbound TCP listener. Core verifies the host's enrolled SSH key and creates a fresh session key for each authorized attachment. A one-use, 60-second ticket attaches the browser stream; device tokens/private keys are never placed in browser URLs. Input, output, resize, close, and buffer limits pass through the core gateway. Duplicate device connections replace the old lease. Revocation invalidates future attachment and heartbeat authorization.

## Pairing

1. Connect to a Taskasaur server and enable Remote Terminal.
2. In Devices, choose Link computer to create a ten-minute single-use pairing code.
3. On a Node.js 24+ computer run `npm run device -- pair https://your-server <code> --terminal` and then `npm run device -- start` (see `scripts/device.ts` for directory/flag handling).
4. Select the online computer in Terminal and connect. Incoming hosting and outgoing control are independent operations.

Electron stores its enrolled identity with OS-backed `safeStorage`. The standalone Node host stores its identity in a directory with mode 0700 and a mode-0600 file; protect this directory as an account credential. TLS is required outside loopback development. Shell execution uses the native host's OS account and its permissions.

`scripts/native-prepare.mjs` repairs the execute bit on the upstream Unix PTY spawn helper during installation. Native packages must include `node-pty` outside Electron's ASAR archive and verify the actual host ABI. A missing PTY only disables incoming hosting, not the terminal controller.

## Acceptance

`tests/integration/terminal.ts` proves enrollment, core WSS routing, SSH host/session keys, a real native PTY round trip and revocation cleanup against the local container gateway. It sends only a generated output marker. Windows/macOS/Linux directed pairs, separate NAT networks, Unicode/resize/backpressure, mobile keyboards and signed release packages remain separate platform acceptance checks. Do not infer those results from the local host test.
