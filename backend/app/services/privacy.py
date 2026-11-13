"""The privacy rule for stored values, as a check in code.

No person's name and no contract detail may be stored in any field, free text
included (write "the engineer" or "the customer" instead). The extraction
prompt asks for that; this is the net under it: it removes what the pattern
rules below can recognise if one slips through. It cannot recognise an
arbitrary name in running text, so the prompt remains the first line of
defence, and a field changed here is marked as doubtful so a person looks at it.
"""
from __future__ import annotations

import re

from app.schemas import TemplateFieldType

# "By A. Engineer on 18/04/2021": a sign-off attribution.
_BY_ON = re.compile(r"\s*[,;.\-–]?\s*\b(?i:by)\s+(?:[A-Z]\.|[A-Z][\w'’-]+)(?:\s+(?:[A-Z]\.|[A-Z][\w'’-]+)){0,3}\s+(?i:on)\s+\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}")
# A role label followed by a name: "Engineer: Jane Doe", "Signed by John Smith".
_ROLE_NAME = re.compile(
    r"\b((?i:engineer|technician|customer|contact|signed by|approved by|name))\s*(?::|\s[-–]\s)\s*"
    r"(?:[A-Z]\.|[A-Z][\w'’-]+)(?:\s+(?:[A-Z]\.|[A-Z][\w'’-]+)){0,3}"
)
_CONTRACT_NUMBER = re.compile(r"\b(?:service\s+)?contract\s*(?:no\.?|number|#|id)?\s*[:#]?\s*[A-Z]{0,4}\d[\w-]{3,}", re.I)
_SMX = re.compile(r"\bSMX\d{5,}\b")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_PHONE = re.compile(r"(?<![\w/])(?:\+\d[\d\s-]{7,}\d|0\d{1,3}[\s-]\d{3,4}[\s-]?\d{3,4})(?![\w/])")

_SIGNED_BY = re.compile(r"\b(?i:signed|approved|checked|reviewed) by\s+(?:[A-Z]\.|[A-Z][\w'’-]+)(?:\s+(?:[A-Z]\.|[A-Z][\w'’-]+)){0,3}")
_ROLES = {"engineer", "technician", "customer", "contact"}

# Hebrew has no capitals, so a name is recognised only by what comes right before it:
# a role label ("מהנדס: <name>", "טכנאית - <name>"), a sign-off ("נחתם על ידי <name>",
# "אושר ע"י <name>") or a title ("ד"ר <name>", "גב' <name>"). A name is one or two Hebrew
# words, or two joined by בן/בת/בר/אבו/אבן ("אורן בן דוד"); a word may be hyphenated
# ("בן-דוד") or carry a geresh ("ג'ני"). A free third word is not taken: it would swallow
# the verb that usually follows. "מר" is not a title here: it is also the word "bitter".
# A label must start a word, so "המהנדס" or "הלקוחה" never match, and a word
# that is itself a role or generic noun is not taken for a name ("אושר על ידי הלקוח").
_HE = "\u05d0-\u05ea"
_Q = "[\"\u05f4]"  # gershayim, typed either way: ד"ר / ד״ר
_G = "['\u05f3]"  # geresh: גב' / גב׳
_SP = "[ \t]+"
_HE_STOP = (
    r"(?!ה?(?:מהנדס|טכנאי|לקוח|מערכת|צוות|חברה|מנהל|שירות|בודק|נציג)(?:ת|ה|ית)?(?![" + _HE + "]))"
)
_HE_PART = "[" + _HE + "](?:[" + _HE + "]|" + _G + "(?=[" + _HE + "]))+" + _G + "?"
# After "by" an action often follows, not a person ("בוצע ע"י החלפת המסנן"): a name never
# starts with one of these verbal nouns, so the sentence is left whole.
_HE_ACTION = (
    r"(?!(?:החלפת|החלפה|בדיקת|בדיקה|מדידת|מדידה|כיול|ניקוי|שימוש|התקנת|התקנה|הוספת|הוספה|"
    r"שטיפת|שטיפה|תיקון|הרכבת|פירוק|ביצוע|הפעלת|כיבוי|עדכון|החזרת|הזנת|טעינת|הידוק|שימון)"
    r"(?![" + _HE + "]))"
)
_HE_WORD = _HE_STOP + _HE_PART + "(?:[-\u05be]" + _HE_PART + ")*"
_HE_JOIN = "(?:בן|בת|בר|אבו|אבן)"
_HE_PERSON = (
    "(?:" + _HE_WORD + _SP + _HE_JOIN + "(?:" + _SP + "|[-\u05be])" + _HE_WORD
    + "|" + _HE_WORD + "(?:" + _SP + _HE_WORD + ")?)(?![" + _HE + "])"
)
_HE_TITLE = "(?:ד" + _Q + "ר|דר" + _G + "|פרופ" + _G + "|פרופסור|גב" + _G + "|הגב" + _G + "|גברת)(?![" + _HE + "])"
_HE_NAME = "(?:" + _HE_TITLE + "[ \t]*)?" + _HE_PERSON
_HE_ROLE_NAME = re.compile(
    "(?<![" + _HE + "])(מהנדסת|מהנדס|טכנאית|טכנאי|לקוחה|לקוח|(?:איש|אשת)[ \t]+קשר)"
    "[ \t]*(?::|[ \t][-–])[ \t]*" + _HE_NAME
)
_HE_SIGNED_BY = re.compile(
    "(?<![" + _HE + "])(?:נחתם|נחתמה|אושר|אושרה|נבדק|נבדקה|בוצע|בוצעה)" + _SP
    + "(?:על(?:" + _SP + "|[-\u05be])ידי|ע" + _Q + "י)[ \t]*:?[ \t]*" + _HE_ACTION + _HE_NAME
)
# A title alone marks a name wherever it stands; the title goes with the name.
_HE_TITLED_NAME = re.compile("(?<![" + _HE + "])" + _HE_TITLE + "[ \t]*" + _HE_PERSON)


def scrub_text(text: str) -> str:
    """The text without sign-off attributions, role-and-name pairs, contract
    numbers, e-mail addresses and phone numbers."""
    out = _ROLE_NAME.sub(lambda m: m.group(1).lower() if m.group(1).lower() in _ROLES else "", text)
    out = _HE_ROLE_NAME.sub(lambda m: re.sub(r"\s+", " ", m.group(1)), out)
    out = _HE_SIGNED_BY.sub("", out)
    out = _HE_TITLED_NAME.sub("", out)
    for rule in (_BY_ON, _SIGNED_BY, _CONTRACT_NUMBER, _SMX, _EMAIL):
        out = rule.sub("", out)
    # A phone number needs 8 or more digits in a row, so part numbers and dates stay.
    out = _PHONE.sub("", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    return re.sub(r"\s+/\s*$", "", out).lstrip(" ,;.-–").rstrip(" ,;-–")


def _scrub_value(value):
    if isinstance(value, str):
        return scrub_text(value)
    if isinstance(value, list):
        return [_scrub_value(v) for v in value]
    if isinstance(value, dict):
        return {k: _scrub_value(v) for k, v in value.items()}
    return value


def scrub_values(fields: list[dict], values: dict) -> tuple[dict, set[str]]:
    """(values with the privacy rule applied to text fields and table text
    cells, names of the fields that were changed)."""
    out, changed = dict(values), set()
    for field in fields:
        name = field["name"]
        if name not in out or field["type"] not in (TemplateFieldType.text, TemplateFieldType.object_list):
            continue
        cleaned = _scrub_value(out[name])
        if cleaned != out[name]:
            out[name], changed = cleaned, changed | {name}
    return out, changed
