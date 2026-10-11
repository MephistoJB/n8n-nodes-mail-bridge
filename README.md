# n8n-nodes-mail-bridge

An n8n community node for safely copying complete, original RFC822 messages
between IMAP mailboxes. After a successful copy it can move the source message
to an archive mailbox and remove archived messages after a retention period.

It is useful when ordinary forwarding is unsuitable because it changes the
message representation, headers, sender, or attachments.

If iCloud rejects a message as too large, the node creates an attachmentless
copy with ` (attachment to big)` appended to its subject and moves the original
source message into the `tobigforicloud` mailbox. Other messages continue to
transfer normally.

Temporary DNS and IMAP connection failures are retried up to four times with
short exponential backoff before the workflow reports an error.

## Installation

In n8n, open **Settings → Community nodes**, install
`n8n-nodes-mail-bridge`, then restart n8n when prompted.

## Credentials

The source account uses n8n's built-in **IMAP** credential. Configure its host,
port, account address, and an app password supplied by the mail provider.

The destination uses **Apple iCloud IMAP**. Enter the iCloud mail address and
an Apple app-specific password. The node connects to `imap.mail.me.com` over
TLS.

## Mail Bridge node

Choose one of these modes:

- **Transfer and Clean Up**: copies source messages to the destination in their
  original RFC822 form, moves each successfully copied source message into the
  archive mailbox, and removes archived messages older than the retention
  period.
- **Transfer Only**: copies and archives without deleting older archive items.
- **Clean Up Only**: removes old messages from the archive mailbox only.

The node never moves a source message before the destination server confirms
that the original has been appended successfully.

## Publishing a release

Push a version tag such as `v1.0.3`. The included GitHub Actions workflow runs
the syntax checks, validates the npm package contents, and publishes the tag's
package version to npm with provenance. Configure npm Trusted Publishing once
for this repository and the `publish-npm` workflow; no long-lived npm token is
required.

## License

[MIT](LICENSE)
