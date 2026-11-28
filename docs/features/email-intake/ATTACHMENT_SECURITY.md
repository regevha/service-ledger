# Email intake: attachment types and what keeps them safe

An email and everything in it is hostile data. Intake reads only from allowed
senders and only PDFs; everything else is recorded and dropped.

## Attachment types

- The type is decided from the first bytes of the file (`services/attachment_types.py`).
  The file name and the declared content type decide nothing.
- Readable types today: PDF only. Anything else is refused with `unsupported_type`
  ("ServiceLedger reads PDF files only") before it is hashed, parsed, stored or counted.
- A file with PDF bytes whose declared type says something else (image, text, zip,
  html, message) is refused as `type_mismatch` (disguise or polyglot signal).
- Non-PDF attachments get one refused row each, at most `EMAIL_MAX_OTHER_FILES_PER_MESSAGE`
  (default 10) per message; the rest are only counted in `files_skipped`.
- To accept a new type later: add it to `SUPPORTED_TYPES` together with its own
  structural check and relevance path. Do not reuse the PDF rules.

## Layers that already exist (unchanged)

1. Sender allow list (address or domain); unknown senders are dropped silently.
2. On IMAP: DMARC/DKIM/SPF verdict from the trusted authserv-id is required.
3. Auto-replies, bounces and the intake address itself are ignored (no mail loops).
4. Message size, MIME part count, PDFs per message and messages per sender per hour are capped.
5. `check_pdf`: magic at byte 0, `%%EOF`, no encryption, page and object limits, time budget,
   no JavaScript, launch actions, embedded files, rich media, XFA or non-page `/OpenAction`.
6. Relevance check without a model call; unsure files wait in the held list.
7. Held files are served as an attachment with `nosniff`; the stored name is a random UUID.
8. Replies go to allowed senders only, are built from stored rows, and escape file names.

## Not covered yet

- A real malware scanner (AC-33).
- Parsing hostile PDFs in a separate, resource-limited process (the check runs in the poller).
- Fillable vendor PDFs with form JavaScript are refused as `unsafe_pdf`; the open decision is
  to hold them for an admin instead.
