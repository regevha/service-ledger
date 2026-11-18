from types import SimpleNamespace
from uuid import uuid4

from app.models import ReportType
from app.services.analytics.comparison import _unit_comparison


def test_comparison_uses_same_labor_parsing_as_fleet():
    instrument = SimpleNamespace(id=uuid4(), name='Test', serial_number='1', status='active')
    reports = [
        SimpleNamespace(extracted_fields={'labour_time': '3,5'}, template=SimpleNamespace(report_type=ReportType.repair), report_date=None),
        SimpleNamespace(extracted_fields={'labor_hours': '2'}, template=SimpleNamespace(report_type=ReportType.preventive_maintenance), report_date=None),
        SimpleNamespace(extracted_fields={'labor_hours': 20}, template=SimpleNamespace(report_type=ReportType.installation_upgrade), report_date=None),
    ]
    result = _unit_comparison(instrument, reports)
    assert result.total_labor_hours == 5.5
    assert result.labor_report_count == 2
