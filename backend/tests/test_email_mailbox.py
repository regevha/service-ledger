from email import policy
from email.parser import BytesParser
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.services.mail_sender import FolderSender, SmtpSender
from app.services.mailbox import FolderMailbox, ImapMailbox, create_mailbox


def settings(**kwargs):
    return Settings(_env_file=None, **kwargs)


def test_folder_bounded_oversized_and_acknowledges_only_handled(tmp_path):
    (tmp_path / 'a.eml').write_bytes(b'From: a@example.invalid\n\n' + b'x' * 200)
    (tmp_path / 'b.eml').write_bytes(b'small')
    with FolderMailbox(tmp_path, max_message_bytes=100, max_messages=1) as mailbox:
        messages = list(mailbox.fetch())
        assert len(messages) == 1
        assert messages[0].raw is None
        assert messages[0].headers == b'From: a@example.invalid\n\n'
        assert messages[0].received_at.utcoffset().total_seconds() == 0
        assert (tmp_path / 'a.eml').exists()
        with pytest.raises(KeyError):
            mailbox.acknowledge('../b.eml')
        mailbox.acknowledge(messages[0].ref)
    assert not (tmp_path / 'a.eml').exists()
    assert (tmp_path / 'b.eml').exists()


def test_folder_sender_idempotent_stable_message_id(tmp_path):
    sender = FolderSender(tmp_path, 'intake@example.invalid')
    sender.send('sender@example.invalid', 'Result', 'Synthetic reply', 'stable-key')
    sender.send('sender@example.invalid', 'Other', 'Other', 'stable-key')
    files = list(tmp_path.glob('*.eml'))
    assert len(files) == 1
    message = BytesParser(policy=policy.default).parsebytes(files[0].read_bytes())
    assert message['Auto-Submitted'] == 'auto-replied'
    assert 'Synthetic reply' in message.get_content()
    assert message['Message-ID'].endswith('@service-ledger.invalid>')


def test_imap_tls_peek_bound_and_targeted_move():
    client = MagicMock()
    client.capabilities = ('IMAP4REV1',)
    client.capability.return_value = ('OK', [b'IMAP4rev1 MOVE'])
    client.select.return_value = ('OK', [b'2'])
    metadata = b'1 (UID 41 RFC822.SIZE 6 INTERNALDATE "26-Nov-2026 10:00:00 +0000")'
    client.uid.side_effect = [('OK', [b'41 42']), ('OK', [metadata]),
                              ('OK', [(b'body', b'hello!')]), ('OK', [b'moved'])]
    with patch('app.services.mailbox.imaplib.IMAP4_SSL', return_value=client) as connect:
        with ImapMailbox(settings(email_max_message_bytes=10), max_messages=1) as mailbox:
            message, = list(mailbox.fetch())
            assert message.raw == b'hello!'
            assert not any(call.args[0] == 'MOVE' for call in client.uid.call_args_list)
            mailbox.acknowledge(message.ref)
            with pytest.raises(ValueError):
                mailbox.acknowledge('42')
    assert connect.call_args.kwargs['ssl_context'].verify_mode != 0
    client.uid.assert_any_call('fetch', b'41', '(BODY.PEEK[]<0.11>)')
    client.uid.assert_any_call('MOVE', '41', '"[Gmail]/Trash"')
    client.expunge.assert_not_called()
    client.logout.assert_called_once()


def test_imap_large_message_only_downloads_bounded_headers():
    client = MagicMock()
    client.capability.return_value = ('OK', [b'MOVE'])
    client.select.return_value = ('OK', [b'1'])
    metadata = b'1 (RFC822.SIZE 999999 INTERNALDATE "26-Nov-2026 10:00:00 +0000")'
    client.uid.side_effect = [('OK', [b'7']), ('OK', [metadata]),
                              ('OK', [(b'header', b'From: a@example.invalid\r\n\r\n')])]
    with patch('app.services.mailbox.imaplib.IMAP4_SSL', return_value=client):
        with ImapMailbox(settings()) as mailbox:
            # Set provider limit below reported size.
            mailbox.settings.email_max_message_bytes = 10
            message, = list(mailbox.fetch())
            assert message.raw is None
            assert message.headers.startswith(b'From:')
    client.uid.assert_any_call('fetch', b'7', '(BODY.PEEK[HEADER]<0.65536>)')


def test_smtp_tls_and_no_credentials_in_failure():
    config = settings(email_username='synthetic', email_app_password='synthetic-secret')
    client = MagicMock()
    with patch('app.services.mail_sender.smtplib.SMTP_SSL') as connect:
        connect.return_value.__enter__.return_value = client
        sender = SmtpSender(config)
        sender.send('sender@example.invalid', 'Result', 'Synthetic', 'key')
        first_id = client.send_message.call_args.args[0]['Message-ID']
        sender.send('sender@example.invalid', 'Result', 'Synthetic', 'key')
        assert client.send_message.call_args.args[0]['Message-ID'] == first_id
        client.login.side_effect = RuntimeError('synthetic-secret')
        with pytest.raises(RuntimeError, match='^mail delivery failed$'):
            sender.send('sender@example.invalid', 'Result', 'Synthetic', 'key')
    assert 'synthetic-secret' not in repr(config)


def test_settings_safe_defaults_and_bounds(tmp_path):
    config = settings(email_fake_inbox_dir=str(tmp_path))
    assert not config.email_intake_enabled
    assert isinstance(create_mailbox(config), FolderMailbox)
    assert config.email_max_messages_per_sender_per_hour == 20
    with pytest.raises(ValidationError):
        settings(email_max_message_bytes=0)


def test_imap_without_any_single_uid_ack_fails_closed():
    client = MagicMock()
    client.capability.return_value = ('OK', [b'IMAP4rev1'])
    client.select.return_value = ('OK', [b'1'])
    with patch('app.services.mailbox.imaplib.IMAP4_SSL', return_value=client):
        with pytest.raises(RuntimeError, match='^mailbox connection failed$'):
            with ImapMailbox(settings()):
                pass
    client.logout.assert_called_once()
    client.uid.assert_not_called()
    client.expunge.assert_not_called()


def test_adapter_limits_cannot_disable_bounds(tmp_path):
    with pytest.raises(ValueError):
        FolderMailbox(tmp_path, max_message_bytes=-1)
    with pytest.raises(ValueError):
        ImapMailbox(settings(), max_messages=0)


def test_imap_uidplus_fallback_expunges_only_the_handled_uid():
    client = MagicMock()
    client.capability.return_value = ("OK", [b"IMAP4rev1 UIDPLUS X-GM-EXT-1"])
    client.select.return_value = ("OK", [b"2"])
    metadata = b'1 (UID 41 RFC822.SIZE 6 INTERNALDATE "26-Nov-2026 10:00:00 +0000")'
    client.uid.side_effect = [
        ("OK", [b"41 42"]), ("OK", [metadata]), ("OK", [(b"body", b"hello!")]),
        ("OK", []), ("OK", []), ("OK", []),
    ]
    with patch("app.services.mailbox.imaplib.IMAP4_SSL", return_value=client):
        with ImapMailbox(settings(), max_messages=1) as mailbox:
            incoming, = list(mailbox.fetch())
            mailbox.acknowledge(incoming.ref)

    assert [call.args for call in client.uid.call_args_list][-3:] == [
        ("COPY", "41", '"[Gmail]/Trash"'),
        ("STORE", "41", "+FLAGS.SILENT", r"(\Deleted)"),
        ("EXPUNGE", "41"),
    ]
    client.expunge.assert_not_called()
