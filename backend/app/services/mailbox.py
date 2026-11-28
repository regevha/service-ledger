"""Bounded mailbox adapters. Call acknowledge only after the intake transaction commits.

Use UID MOVE, or a UIDPLUS fallback that expunges only the handled message.
The poller retries a failed acknowledgement with the same message key.
"""
from __future__ import annotations

import imaplib
import os
import re
import ssl
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Protocol

from app.config import Settings


@dataclass(frozen=True)
class RawMessage:
    ref: str
    raw: bytes | None
    received_at: datetime
    headers: bytes | None = None  # bounded header-only snapshot for oversized refusal replies


class Mailbox(Protocol):
    def fetch(self) -> Iterable[RawMessage]: ...
    def acknowledge(self, ref: str) -> None: ...


class FolderMailbox:
    def __init__(self, directory: str | Path, max_message_bytes: int = 50 * 1024 * 1024,
                 max_messages: int = 20):
        if max_message_bytes <= 0 or max_messages <= 0:
            raise ValueError('mailbox limits must be positive')
        self.directory = Path(directory)
        self.max_message_bytes = max_message_bytes
        self.max_messages = max_messages
        self._handled: dict[str, Path] = {}

    def __enter__(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        return self

    def __exit__(self, *args):
        return None

    def fetch(self) -> Iterable[RawMessage]:
        self.directory.mkdir(parents=True, exist_ok=True)
        count = 0
        for path in sorted(self.directory.glob('*.eml')):
            if count >= self.max_messages:
                break
            if path.is_symlink() or not path.is_file():
                continue
            with path.open('rb') as source:
                stat = source.fileno()
                received = datetime.fromtimestamp(os.fstat(stat).st_mtime, timezone.utc)
                data = source.read(self.max_message_bytes + 1)
            self._handled[path.name] = path
            count += 1
            oversized = len(data) > self.max_message_bytes
            yield RawMessage(path.name, None if oversized else data, received,
                             _headers(data) if oversized else None)

    def acknowledge(self, ref: str) -> None:
        path = self._handled.pop(ref)  # refuse refs not yielded by this adapter
        path.unlink(missing_ok=True)


class ImapMailbox:
    def __init__(self, settings: Settings, max_messages: int = 20):
        if max_messages <= 0:
            raise ValueError('mailbox limits must be positive')
        self.settings = settings
        self.max_messages = max_messages
        self._client = None
        self._handled: set[str] = set()
        self._supports_move = False

    def __enter__(self):
        self._handled.clear()
        settings = self.settings
        try:
            client = imaplib.IMAP4_SSL(settings.email_imap_host, settings.email_imap_port,
                                      ssl_context=ssl.create_default_context(), timeout=30)
            self._client = client
            client.login(settings.email_username.get_secret_value(), settings.email_app_password.get_secret_value())
            # Capabilities may change after authentication. IMAP4.capabilities
            # is the greeting snapshot, not necessarily the authenticated set.
            capabilities = b" ".join(self._ok(client.capability())).upper().split()
            self._supports_move = b"MOVE" in capabilities
            if not self._supports_move and b"UIDPLUS" not in capabilities:
                raise RuntimeError("mailbox cannot acknowledge a single UID")
            self._ok(client.select(settings.email_imap_folder))
        except Exception:
            self.__exit__()
            raise RuntimeError('mailbox connection failed') from None
        return self

    def __exit__(self, *args):
        self._handled.clear()
        if self._client is not None:
            try:
                self._client.logout()
            except Exception:
                pass
            self._client = None

    @staticmethod
    def _ok(result):
        if result[0] != 'OK':
            raise RuntimeError('mailbox operation failed')
        return result[1]

    def fetch(self) -> Iterable[RawMessage]:
        if self._client is None:
            raise RuntimeError('enter mailbox context before fetching')
        data = self._ok(self._client.uid('search', None, 'ALL'))
        for uid in (data[0] or b'').split()[:self.max_messages]:
            if not uid.isdigit():
                raise RuntimeError('invalid mailbox UID')
            metadata = self._ok(self._client.uid('fetch', uid, '(RFC822.SIZE INTERNALDATE)'))
            header = next((part for part in metadata if isinstance(part, bytes)), b'')
            size_match = re.search(rb'RFC822.SIZE (\d+)', header)
            date_tuple = imaplib.Internaldate2tuple(header)
            if size_match is None or date_tuple is None:
                raise RuntimeError('missing mailbox metadata')
            received = datetime.fromtimestamp(time.mktime(date_tuple), timezone.utc)
            raw = None
            if int(size_match[1]) <= self.settings.email_max_message_bytes:
                payload = self._ok(self._client.uid('fetch', uid,
                    f'(BODY.PEEK[]<0.{self.settings.email_max_message_bytes + 1}>)'))
                literals = [part[1] for part in payload if isinstance(part, tuple)]
                if len(literals) != 1:
                    raise RuntimeError('missing mailbox payload')
                raw = literals[0]
                if len(raw) > self.settings.email_max_message_bytes:
                    raw = None
            headers = None
            if raw is None:
                response = self._ok(self._client.uid('fetch', uid, '(BODY.PEEK[HEADER]<0.65536>)'))
                literals = [part[1] for part in response if isinstance(part, tuple)]
                if len(literals) == 1:
                    headers = _headers(literals[0])
            ref = uid.decode('ascii')
            self._handled.add(ref)
            yield RawMessage(ref, raw, received, headers)

    def acknowledge(self, ref: str) -> None:
        if self._client is None or ref not in self._handled:
            raise ValueError('message was not fetched by this mailbox')
        folder = self.settings.email_imap_trash_folder
        if not folder or not folder.isascii() or not folder.isprintable():
            raise ValueError("invalid mailbox Trash folder")
        trash = '"' + folder.replace(chr(92), chr(92) * 2).replace('"', chr(92) + '"') + '"'
        if self._supports_move:
            self._ok(self._client.uid("MOVE", ref, trash))
        else:
            self._ok(self._client.uid("COPY", ref, trash))
            self._ok(self._client.uid("STORE", ref, "+FLAGS.SILENT", r"(\Deleted)"))
            self._ok(self._client.uid("EXPUNGE", ref))
        self._handled.remove(ref)


def create_mailbox(settings: Settings) -> FolderMailbox | ImapMailbox:
    if settings.email_mailbox == 'folder':
        return FolderMailbox(settings.email_fake_inbox_dir, settings.email_max_message_bytes)
    return ImapMailbox(settings)


def _headers(data: bytes) -> bytes | None:
    # Do not expose incomplete headers (e.g. a truncated authentication field).
    prefix = data[:65536]
    for separator in (b"\r\n\r\n", b"\n\n"):
        if separator in prefix:
            return prefix.split(separator, 1)[0] + separator
    return None
