"""Read page counts and assemble selected upload pages without creating reports."""

from __future__ import annotations

from io import BytesIO

from fastapi import HTTPException, UploadFile
from PIL import Image, ImageOps
from pydantic import BaseModel, Field, ValidationError
from pypdf import PdfReader, PdfWriter

from app.config import get_settings
from app.services.documents import PDF, detect_media_type

MAX_SOURCES = 30
MAX_PAGES = 80
MAX_PHOTO_PIXELS = 25_000_000


class PageSelection(BaseModel):
    source: int = Field(ge=0)
    page: int = Field(ge=1)


class Composition(BaseModel):
    pages: list[PageSelection] = Field(min_length=1, max_length=MAX_PAGES)


async def load_source(file: UploadFile) -> tuple[bytes, str]:
    settings = get_settings()
    header = await file.read(1024)
    media = detect_media_type(header)
    if not media:
        raise HTTPException(415, "Choose a PDF or photo.")
    limit = settings.max_pdf_upload_bytes if media == PDF else settings.max_image_upload_bytes
    remainder = await file.read(limit - len(header) + 1)
    if len(header) + len(remainder) > limit:
        raise HTTPException(413, "This file is too large. Choose a smaller file.")
    return header + remainder, media


def pdf_reader(data: bytes) -> PdfReader:
    try:
        reader = PdfReader(BytesIO(data))
        if reader.is_encrypted or not 1 <= len(reader.pages) <= MAX_PAGES:
            raise ValueError
        return reader
    except Exception as exc:
        raise HTTPException(422, f"Choose an unlocked PDF with 1 to {MAX_PAGES} pages.") from exc


def source_page_count(data: bytes, media: str) -> int:
    return len(pdf_reader(data).pages) if media == PDF else 1


def photo_as_pdf(data: bytes) -> bytes:
    try:
        with Image.open(BytesIO(data)) as source:
            if source.width * source.height > MAX_PHOTO_PIXELS:
                raise ValueError
            photo = ImageOps.exif_transpose(source).convert("RGBA")
            photo.thumbnail((2000, 2000))
            bg = Image.new("RGB", photo.size, "white")
            bg.paste(photo, mask=photo.getchannel("A"))
            output = BytesIO()
            bg.save(output, format="PDF")
            return output.getvalue()
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise HTTPException(422, "This photo could not be read. Try a smaller JPEG.") from exc


async def compose(sources: list[UploadFile], selection_json: str) -> bytes:
    if not 1 <= len(sources) <= MAX_SOURCES:
        raise HTTPException(422, f"Choose up to {MAX_SOURCES} source files.")
    try:
        selection = Composition.model_validate_json(selection_json)
    except ValidationError as exc:
        raise HTTPException(422, "Choose the pages for this report.") from exc
    if any(page.source >= len(sources) for page in selection.pages):
        raise HTTPException(422, "A selected source file is missing.")

    readers: dict[int, PdfReader] = {}
    total = 0
    limit = get_settings().max_pdf_upload_bytes
    for source in {page.source for page in selection.pages}:
        contents, media = await load_source(sources[source])
        total += len(contents)
        if total > limit:
            raise HTTPException(413, "These pages exceed the PDF size limit. Split them into smaller reports.")
        reader = pdf_reader(contents if media == PDF else photo_as_pdf(contents))
        if media == PDF and reader.get_fields():
            raise HTTPException(422, "This PDF contains fillable fields. Save a flattened copy before mixing or splitting its pages.")
        readers[source] = reader

    writer = PdfWriter()
    for page in selection.pages:
        pages = readers[page.source].pages
        if page.page > len(pages):
            raise HTTPException(422, "A selected page is missing.")
        # A composed report needs the page content, without annotations or actions.
        writer.add_page(pages[page.page - 1], excluded_keys=("/Annots", "/AA"))
    output = BytesIO()
    writer.write(output)
    if output.tell() > limit:
        raise HTTPException(413, "The composed PDF is too large. Split it into smaller reports.")
    return output.getvalue()
