"""The privacy rule's safety net (app/services/privacy.py) and its use in extraction."""
import pytest

from app.services import extraction
from app.services.privacy import scrub_text, scrub_values


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Air bubble in bleach line. By A. Engineer on 18/04/2021", "Air bubble in bleach line"),
        ("11 Month Recurring / SMX0000001", "11 Month Recurring"),
        ("Engineer: Jane Doe replaced the filter", "engineer replaced the filter"),
        ("Signed by John Smith. System ready", "System ready"),
        ("Contract number: 12345678 expired", "expired"),
        ("Write to jane.doe@example.com or call +49 170 1234567 today", "Write to or call today"),
        ("Call 03-555 1234 now", "Call now"),
    ],
)
def test_names_and_contract_details_are_removed(text, expected):
    assert scrub_text(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "Replaced part 34363910 on 06/05/2026",
        "Checked by the engineer after repair",
        "Fluidics pressure 12.5 psi, flow 1.0 ml/min",
        "Replaced the sheath filter and primed the system three times.",
        "",
    ],
)
def test_ordinary_text_is_left_alone(text):
    assert scrub_text(text) == text


# Hebrew has no capitals, so a name is recognised by the role label before it.
# The names below are invented.
@pytest.mark.parametrize(
    "text, name",
    [
        ("מהנדס: תמר אלנבוים החליפה את המסנן", "אלנבוים"),
        ("טכנאי: אורן שלגון בדק את הלחץ", "שלגון"),
        ("לקוח - נועה פרלמוטר אישרה את התיקון", "פרלמוטר"),
        ("איש קשר: גיל הרשקוביץ", "הרשקוביץ"),
        ("נחתם על ידי יובל מרגלית. המערכת מוכנה", "מרגלית"),
        ("אושר על ידי ענת קורמן", "קורמן"),
    ],
)
def test_hebrew_names_after_a_role_label_are_removed(text, name):
    out = scrub_text(text)
    assert name not in out
    assert out != text


# Forms the first rules missed (Wave A review). Every word of the invented name must go,
# not only the surname, and the rest of the sentence must stay.
@pytest.mark.parametrize(
    "text, expected",
    [
        # Feminine role labels.
        ("מהנדסת: תמר אלנבוים החליפה את המסנן", "מהנדסת החליפה את המסנן"),
        ("טכנאית: שירה גולדפרב בדקה את הלחץ", "טכנאית בדקה את הלחץ"),
        ("לקוחה - נועה פרלמוטר אישרה את התיקון", "לקוחה אישרה את התיקון"),
        ("אשת קשר: גלית הרשקוביץ", "אשת קשר"),
        # The abbreviation ע"י, with an ASCII quote and with gershayim.
        ('נחתם ע"י יובל מרגלית. המערכת מוכנה', "המערכת מוכנה"),
        ("אושר ע״י ענת קורמן", ""),
        # A name after a title, alone or after a role label.
        ('ד"ר רונית שגיא בדקה את המכשיר', "בדקה את המכשיר"),
        ("הבדיקה בוצעה מול ד״ר רונית שגיא", "הבדיקה בוצעה מול"),
        ("פרופ' עמית זלצמן אישר את הכיול", "אישר את הכיול"),
        ("גב' דנה ורדימון חתמה על הדוח", "חתמה על הדוח"),
        ('מהנדס: ד"ר אבי שטרנליכט החליף את המשאבה', "מהנדס החליף את המשאבה"),
        # Three-word names with a joining word, and hyphenated surnames.
        ("טכנאי: אורן בן דוד בדק את הלחץ", "טכנאי בדק את הלחץ"),
        ("נחתם על ידי מאיה בת שבע", ""),
        ("מהנדס: אורן בן-דוד", "מהנדס"),
        ("טכנאית: ג'ני צ'רניאק החליפה אטם", "טכנאית החליפה אטם"),
    ],
)
def test_more_hebrew_name_forms_are_removed_whole(text, expected):
    assert scrub_text(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "החלפת מסנן וביצוע שטיפה לקו ההלבנה",
        "לחץ הנוזלים 12.5 psi, זרימה 1.0 מ״ל לדקה",
        "המהנדס בדק את המערכת לאחר התיקון",
        "הלקוח ביקש לבדוק שוב את הצינורית",
        "תקלה במשאבה, הוחלף אטם מספר 641922",
        "המהנדסת בדקה את המערכת והלקוחה אישרה",
        "הוחלף על ידי החלפת המסנן",
        "המים מרים מעט, נבדק pH",
        "הטעם מר מאוד לאחר השטיפה",
        'הוחלף ע"י הטכנאית',
        "הבדיקה נעשתה בן לילה",
    ],
)
def test_hebrew_text_without_a_role_label_is_left_alone(text):
    assert scrub_text(text) == text


def test_a_hebrew_field_the_check_changed_is_left_doubtful(monkeypatch):
    template_fields = [{"name": "work_performed", "type": "text", "unit": None, "notes": None}]

    class T:
        field_schema = {"fields": template_fields}

    monkeypatch.setattr(extraction.settings, "use_live_claude", False)
    monkeypatch.setattr(extraction.settings, "stub_extract_from_text", False)
    monkeypatch.setattr(
        extraction,
        "_stub_extract",
        lambda a, t: extraction.ExtractionResult(
            {"work_performed": "הוחלף אטם. מהנדס: תמר אלנבוים"}, {"work_performed": 0.95, "report_date": 0.9}, None
        ),
    )
    result = extraction.extract(object(), T())
    assert "אלנבוים" not in result.extracted_fields["work_performed"]
    assert "הוחלף אטם" in result.extracted_fields["work_performed"]
    assert result.field_confidences["work_performed"] == 0.5
    assert result.field_confidences["report_date"] == 0.9


def test_scrub_values_covers_text_fields_and_table_cells_and_reports_what_changed():
    fields = [
        {"name": "work_performed", "type": "text"},
        {"name": "components_replaced", "type": "object[]"},
        {"name": "labor_hours", "type": "number"},
        {"name": "root_cause", "type": "text"},
    ]
    values = {
        "work_performed": "Replaced O-ring. By A. Engineer on 18/04/2021",
        "components_replaced": [{"part_name": "Filter, Engineer: Jane Doe", "part_number": "641922", "qty": 1}],
        "labor_hours": 2.5,
        "root_cause": "Worn seal",
    }
    out, changed = scrub_values(fields, values)
    assert changed == {"work_performed", "components_replaced"}
    assert out["work_performed"] == "Replaced O-ring"
    assert out["components_replaced"][0]["part_name"] == "Filter, engineer"
    assert out["components_replaced"][0]["part_number"] == "641922" and out["labor_hours"] == 2.5


def test_a_field_the_check_changed_is_left_doubtful(monkeypatch):
    template_fields = [{"name": "work_performed", "type": "text", "unit": None, "notes": None}]

    class T:
        field_schema = {"fields": template_fields}

    monkeypatch.setattr(extraction.settings, "use_live_claude", False)
    monkeypatch.setattr(extraction.settings, "stub_extract_from_text", False)
    monkeypatch.setattr(
        extraction,
        "_stub_extract",
        lambda a, t: extraction.ExtractionResult(
            {"work_performed": "Replaced seal. By A. Engineer on 18/04/2021"}, {"work_performed": 0.95, "report_date": 0.9}, None
        ),
    )
    result = extraction.extract(object(), T())
    assert result.extracted_fields["work_performed"] == "Replaced seal"
    assert result.field_confidences["work_performed"] == 0.5
    assert result.field_confidences["report_date"] == 0.9


def test_the_prompt_states_the_rule():
    assert "no person's name and no contract detail may appear in any field, free text included" in extraction._EXTRACT_PROMPT_HEADER
    assert '"the engineer" or "the customer"' in extraction._EXTRACT_PROMPT_HEADER
