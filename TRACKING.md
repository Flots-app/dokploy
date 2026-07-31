# S3 backup encryption at rest

## TODO

- None.

## IN PROGRESS

- [ ] Publish the reviewed implementation as a draft pull request against
  `Flots-app/dokploy:canary`.

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
