# Taskasaur distributed workspace

This repository owns the portable TypeScript core, local replicas, peer sync, shared UI, native adapters, headless runtime and plugin SDK. The sibling `taskasaur-server` repository is historical and must not be modified. Preserve the existing uncommitted planning documents.

Keep the portable core free of Node, Electron and browser UI imports. Put platform-specific services behind explicit capabilities. Plugins use core storage, field contracts and messaging; replicas must never execute commands just because data arrived. All writes need durable persistence before acknowledgement. Never commit credentials, pairing invitations or runtime data.

Run platform build/verification, typecheck, meaningful synchronization/security tests, web/native/headless builds and relevant integration checks. Preserve rollback through logical commits on top of existing history.
