from io import BytesIO

from PIL import Image
from pypdf import PdfReader, PdfWriter


def test_compose_mixed_sources_in_selected_order(client):
    pdf = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=300, height=400)
    writer.add_blank_page(width=500, height=600)
    writer.write(pdf)
    photo = BytesIO()
    Image.new("RGB", (72, 96), "white").save(photo, format="PNG")

    inspect = client.post("/uploads/inspect", files={"file": ("two.pdf", pdf.getvalue(), "application/pdf")})
    assert inspect.json() == {"page_count": 2}

    response = client.post(
        "/uploads/compose",
        files=[
            ("files", ("two.pdf", pdf.getvalue(), "application/pdf")),
            ("files", ("photo.png", photo.getvalue(), "image/png")),
        ],
        data={"selection": '{"pages":[{"source":0,"page":2},{"source":1,"page":1},{"source":0,"page":1}]}'},
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert [float(page.mediabox.width) for page in PdfReader(BytesIO(response.content)).pages] == [500, 72, 300]
    assert client.get("/reports").json() == []


def test_composer_rejects_an_out_of_range_page(client):
    out = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.write(out)
    response = client.post(
        "/uploads/compose",
        files={"files": ("one.pdf", out.getvalue(), "application/pdf")},
        data={"selection": '{"pages":[{"source":0,"page":2}]}'},
    )
    assert response.status_code == 422
