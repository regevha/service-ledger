from email.message import EmailMessage

from app.services.email_message import authentication_verdict, parse_message


def test_synthetic_message_attachments_and_stable_key():
    msg = EmailMessage()
    msg['From'] = 'Synthetic <sender@example.invalid>'
    msg['Message-ID'] = '<stable@example.invalid>'
    msg.set_content('ignored private body')
    msg.add_attachment(b'%PDF-fake', maintype='application', subtype='pdf', filename='private.pdf')
    parsed = parse_message(msg.as_bytes())
    assert parsed.from_address == 'sender@example.invalid'
    assert parsed.attachments[0].data == b'%PDF-fake'
    assert parsed.message_key == parse_message(msg.as_bytes()).message_key
    assert parsed.sender_verified is None
    assert 'private' not in repr(parsed)


def test_rejects_large_ambiguous_and_automatic_mail():
    assert parse_message(b'x' * 5, max_message_bytes=4).too_large
    assert parse_message(None).unreadable
    assert parse_message(b'From: a@example.invalid, b@example.invalid\n\n').from_address is None
    assert parse_message(b'Auto-Submitted: auto-replied\n\n').is_auto_reply
    assert parse_message(b'Return-Path: <>\n\n').is_auto_reply


def test_trusted_authentication_only_and_topmost_result():
    assert authentication_verdict(['mx.test; dmarc=pass'], 'mx.test', 'a@example.invalid')
    assert not authentication_verdict(['evil; dmarc=pass'], 'mx.test', 'a@example.invalid')
    assert not authentication_verdict(['mx.test; dmarc=fail', 'mx.test; dmarc=pass'], 'mx.test', 'a@example.invalid')
    assert not authentication_verdict(['mx.test; dkim=pass header.d=evil.invalid'], 'mx.test', 'a@example.invalid')
