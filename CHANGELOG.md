# Changelog

## 1.1.0

- Transfer oversized messages without attachments and prefix the subject with `[Anhang ausgelagert]`.
- Preserve the complete original permanently in a configurable source exception mailbox.
- Use MIME parsing/composition to preserve plain text, HTML, addresses, thread references and the original date; remove binary attachments including inline images.
- Add a stable import key and deterministic Message-ID to prevent duplicate reduced copies when retrying an interrupted archive move.
- Make the preflight size limit configurable (default: 20 decimal MB), with a fallback for server `TOOBIG` errors.
- Isolate per-message failures, preserve partial progress counters, and never apply retention cleanup to oversized originals.
- Support backfilling originals already stored in the exception mailbox without moving or deleting them.
- Avoid destination connections for empty source mailboxes and consume fetch iterators before subsequent source commands.
- Retain the transient connection retries introduced in 1.0.6.
- Add automated MIME, retry, failure-isolation and retention tests and run them before npm publishing.

### Migration

The default oversized mailbox is now `iCloud_zu_gross`. Existing users of 1.0.6 may configure `tobigforicloud` to retain the previous location. Existing original messages in either location are not deleted or moved automatically. The old subject suffix is replaced by the new prefix for newly generated copies.
