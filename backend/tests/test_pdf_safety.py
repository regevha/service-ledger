from io import BytesIO

from pypdf import PdfWriter

from app.services.pdf_safety import check_pdf


def pdf_bytes(*, javascript=False, encrypted=False, pages=1):
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=200, height=200)
    if javascript:
        writer.add_js('app.alert("test")')
    if encrypted:
        writer.encrypt('synthetic')
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def test_valid_pdf_and_limits():
    data = pdf_bytes()
    assert check_pdf(data).ok
    assert check_pdf(data).page_count == 1
    assert check_pdf(data, max_bytes=1).status == 'too_large'
    assert check_pdf(b'not PDF').status == 'not_pdf'


def test_refuses_active_encrypted_empty_and_truncated_pdf():
    for data in (pdf_bytes(javascript=True), pdf_bytes(encrypted=True), pdf_bytes(pages=0), pdf_bytes()[:-50]):
        assert check_pdf(data).status == 'unsafe_pdf'
