# n8n-nodes-mail-bridge

An n8n community node for copying complete RFC822 messages from an IMAP mailbox
to iCloud. After a confirmed append, source messages are moved to an archive.
Archive retention is optional. No SMTP messages are sent.

## Installation

In n8n, open **Settings → Community nodes** and install or update
`n8n-nodes-mail-bridge`. Restart n8n when prompted.

The source uses n8n's built-in **IMAP** credential. The destination uses **Apple
iCloud IMAP** with a full email address and an app-specific password. Existing
credentials using `appleId` instead of `mailAddress` remain supported.

## Modes

- **Transfer and Clean Up:** append messages, archive confirmed source copies,
  then delete ordinary archive messages older than the configured number of months.
- **Transfer Only:** append and archive without retention cleanup.
- **Clean Up Only:** clean the ordinary source archive.

The retention cutoff uses the original message date, not the archive-move date.
The default is six months. Complete messages within the size limit are appended
without changing their RFC822 bytes. The destination server can normalize bytes
such as a final line ending.

## Oversized messages

Attachment offloading is enabled by default. Messages larger than the configured
full RFC822 size (default: **20 decimal MB**) are rebuilt without attachments.
A server `TOOBIG` response can trigger the same fallback even below that limit.

The new subject begins with **`[Anhang ausgelagert]`**. Text, HTML, addresses,
thread references and the original Date are retained where present. Inline image
parts are removed too, and CID image references are replaced with a text marker.
A notice identifies the source account, original Message-ID, removed filenames
and the source exception folder. The original IMAP internal date and Seen flag
are passed to the destination.

The complete original, including all attachments, is moved to the configurable
exception folder **only after the destination confirms the reduced copy**. The
default folder is `iCloud_zu_gross`; use a separate folder for sent mail if desired.
Exception folders are never included in this node's retention cleanup.

Reduced copies have a deterministic Message-ID and `X-N8N-Mail-Import-Key` derived
from account, destination and complete original bytes. A retry checks this key
in the standard Message-ID header before creating another reduced copy. Custom
X-* header indexing is not required. The original Message-ID is retained in
`X-Original-Message-ID`. This deduplication guarantee concerns reduced copies;
ordinary unchanged RFC822 appends retain the existing append/move crash window.

For a one-time backfill, the source mailbox may equal the oversized-original
mailbox in Transfer Only mode. Already delivered reduced copies are skipped,
and originals in that mailbox are never moved or deleted by the backfill.

An oversized body that cannot fit after attachment removal, an attachment-free
oversized message, or an encrypted message cannot be safely reconstructed by
this node. The original is preserved in the exception folder and an explicit
error is returned. Text is never silently truncated. Temporary append failures
leave the original in its current source folder for retry.

## Reliability and output

Transient connection failures are retried up to four times with exponential
backoff. Authentication errors and appends are not blindly retried. One message
failure does not stop the remaining messages in the selected batch.

The result includes `success`, `transferred`, `deleted`, `offloaded`,
`duplicatesSkipped`, `preservedWithoutCopy`, `errors` and an aggregate `error`.
Partial progress is retained even when a later message fails. Empty source
mailboxes do not create an iCloud connection.

## Development and releases

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run check
npm test
npm pack --dry-run
```

GitHub Actions tests Node.js 22 and 24. Pushing a version tag such as `v1.1.0`
runs checks/tests and publishes the matching npm version with provenance using
the repository's configured Trusted Publishing environment. No registry token
is included in the repository or package. See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
