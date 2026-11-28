"""Place a test message in the local folder inbox without sending real mail."""
from __future__ import annotations

import argparse
import uuid
from email import policy
from email.message import EmailMessage
from pathlib import Path

from app.config import get_settings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="sender", required=True)
    parser.add_argument("--message-id", help="Reuse a message ID to demonstrate redelivery.")
    parser.add_argument("files", type=Path, nargs="+")
    args = parser.parse_args()
    settings = get_settings()
    if not settings.email_intake_enabled or settings.email_mailbox != "folder":
        parser.error("Enable the folder mailbox before using this demo tool.")
    message = EmailMessage(policy=policy.SMTP)
    message["From"] = args.sender
    message["To"] = settings.email_intake_address
    message["Subject"] = "ServiceLedger demo"
    message["Message-ID"] = args.message_id or f"<{uuid.uuid4().hex}@example.invalid>"
    message.set_content("Synthetic report attachments for the local demo.")
    for position, file in enumerate(args.files, start=1):
        if not file.is_file() or file.stat().st_size > settings.max_pdf_upload_bytes:
            parser.error(f"Attachment {position} does not exist or exceeds the PDF size limit.")
        message.add_attachment(file.read_bytes(), maintype="application", subtype="pdf", filename=f"report-{position}.pdf")
    data = message.as_bytes()
    if len(data) > settings.email_max_message_bytes:
        parser.error("The encoded message exceeds the inbox size limit.")
    inbox = Path(settings.email_fake_inbox_dir)
    inbox.mkdir(parents=True, exist_ok=True)
    path = inbox / uuid.uuid4().hex
    temporary = path.with_suffix(".tmp")
    try:
        temporary.write_bytes(data)
        temporary.replace(path.with_suffix(".eml"))
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Placed one message with {len(args.files)} attachment(s) in the folder inbox.")


if __name__ == "__main__":
    main()
