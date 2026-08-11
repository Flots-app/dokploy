# S3 backup encryption at rest

## TODO

- None.

## IN PROGRESS

- None.

## TO VERIFY

- [ ] Run one backup/restore smoke test on a real remote Dokploy server and a
  production S3 provider during review; this needs external infrastructure and
  credentials that are not available in this workspace.

## DONE

- [x] Confirmed the local repository and PR target context.
- [x] Retrieved PR metadata, changed-file list, discussion, reviews, and review threads.
- [x] Audited `Dokploy/dokploy#3194` against upstream `canary`, this fork, and
  the official rclone crypt documentation.
- [x] Reproduced the source PR's raw-password failure with rclone: crypt
  passwords supplied through config environment variables must first be
  obscured.
- [x] Rejected the source PR's mutable encryption settings because disabling or
  rotating crypt credentials makes existing objects unreadable.
- [x] Identified source-PR regressions in retention (`xargs` plus environment
  assignment), volume remote paths, encryption-aware connection tests, LibSQL,
  Compose runtime selection, `additionalFlags`, and credential redaction.
- [x] Designed a versioned encrypted namespace at
  `.dokploy/encrypted/v1`, leaving legacy plaintext destinations unchanged.
- [x] Added schema constraints, generated migration `0176_petite_vector`, API
  validation/redaction, and immutable encryption configuration after creation.
- [x] Added the destination UI with secure browser-generated passwords,
  filename/directory encryption controls, and explicit recovery guidance.
- [x] Routed PostgreSQL, MySQL, MariaDB, MongoDB, LibSQL, Compose, web-server,
  and volume backup/list/restore/retention operations through one crypt-aware
  command builder.
- [x] Kept obscured crypt secrets out of command arguments and error command
  strings: native child-process environments locally and stdin-fed exports over
  SSH, with defensive error redaction.
- [x] Added traversal/control-character rejection and shell-safe path handling;
  repaired nested local filenames for web-server and volume restores.
- [x] Passed 39 focused encryption, redaction, remote-environment, and command
  injection tests.
- [x] Passed the complete non-real suite: 77 files and 732 tests.
- [x] Passed server and Dokploy typechecks, Biome format/lint, migration
  consistency, server bundle, and production Next.js build.
- [x] Validated actual rclone v1.74.4 behavior against MinIO: upload, logical
  listing, restore, encrypted physical filenames/content, and no crypt secret in
  generated command strings.
- [x] Published draft pull request
  [Flots-app/dokploy#13](https://github.com/Flots-app/dokploy/pull/13) against
  `canary`.
- [x] Expanded focused coverage to 43 passing tests for crypt modes,
  per-destination namespaces, inherited environment isolation, path and local
  filename boundaries, retention command safety, schema rules, service
  redaction, storage immutability, and SSH stdin environment transfer.
- [x] Fixed update-response disclosure of the reversible obscured crypt
  passwords.
- [x] Isolated encrypted object roots by immutable `destinationId` so two
  destinations sharing one bucket but using different keys cannot mix data.
- [x] Froze encrypted storage identity (provider, bucket, region, endpoint, and
  additional flags) while preserving display-name edits and S3 credential
  rotation.
- [x] Explicitly pinned every security-relevant crypt environment option,
  cleared an inherited optional `password2`, enabled strict name handling, and
  rejected additional `--crypt-*` overrides.
- [x] Reproduced that rclone `copyto` exits successfully when its source is
  absent; added `--error-on-no-transfer` to every upload/download `copyto` and
  verified the resulting exit code 9 against MinIO.
- [x] Made retention fail closed: positive safe-integer validation, Bash
  `pipefail`, a required non-empty listing, an authenticated one-byte read, and
  stdin file deletion restricted to Dokploy backup extensions.
- [x] Added database checks for disabled-destination secret absence and the
  filename/directory mode invariant; migration generation reports no schema
  drift.
- [x] Passed the real rclone/MinIO edge matrix for all three filename modes,
  directory modes, special-character passwords, password2 present/absent,
  binary and zero-byte payloads, wrong keys, deliberate ciphertext corruption,
  destination isolation, and plaintext legacy coexistence.
- [x] Passed real encrypted retention for database and volume patterns,
  keep-latest ordering, unrelated-file preservation, and wrong-key failures
  with both encrypted and plaintext filenames.
- [x] Passed Biome over all 907 files, all workspace typechecks, server build,
  production server bundle, full Next.js production build, and migration
  consistency. The current non-real suite passes 748/749 tests; the sole local
  failure is an unrelated Compose cancellation test timing out at 5 seconds on
  Node 22 and is delegated to the Node 24/Linux CI run.
- [x] Published hardening commit `207811d9a` and passed every required check on
  draft PR #13 under Node 24/Linux: Plumber compliance, quality, typecheck,
  complete test suite, and production build.
- [x] Cross-checked the requested key-ownership model against Azure's
  platform-managed and customer-managed key responsibilities, then adapted the
  concept to rclone's client-side crypt model without claiming external-vault
  or online key-revocation semantics.
- [x] Added an immutable `encryptionKeyManagement` contract with
  `dokploy`/`customer` modes. New destinations default to Dokploy-managed keys;
  customer-managed mode requires user-provided recovery secrets.
- [x] Moved managed-key generation entirely to the server using two independent
  256-bit CSPRNG values. Managed mode rejects client-supplied key material, and
  disabled encryption rejects unused secrets.
- [x] Wrapped both rclone-obscured passwords in Dokploy's AES-256-GCM
  `encryptedText` storage while preserving API redaction and legacy plaintext
  read compatibility.
- [x] Added database constraints for valid key-management modes and the required
  secondary secret on Dokploy-managed encrypted destinations; migration
  generation reports no schema drift.
- [x] Added an accessible key-management selector, explicit recovery ownership
  guidance, immutable-mode messaging, and visible destination-list badges.
- [x] Expanded focused coverage to 48 passing tests, including API ownership
  rules, server-side key entropy/independence, encrypted-at-rest persistence,
  secret redaction, command safety, and both disabled/enabled boundaries.
- [x] Passed a real rclone v1.75.0/MinIO integration for Dokploy-managed and
  customer-managed namespaces: exact upload/restore hashes, distinct encrypted
  physical names/content, isolation between key sets, and exit-code 9 failures
  for a wrong primary key or missing managed secondary key.
- [x] Passed Biome across all 907 files, all four workspace typechecks, the
  server production bundle, the full Next.js production build, and migration
  consistency. The non-real local suite passes 753/754 tests under Node 26;
  only the unrelated pre-existing Compose cancellation test exceeds its local
  5-second timeout and remains delegated to the Node 24/Linux CI gate.
- [x] Rebased the complete encryption branch onto current `canary`, published
  managed-key commit `ccacd0a34`, and updated draft PR #13 with the ownership,
  recovery, threat-boundary, cross-source, and validation details.
- [x] Passed every required GitHub check after publication under Node 24/Linux:
  Plumber compliance, quality, typecheck, complete test suite, and production
  build.
