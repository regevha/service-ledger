"""baseline: the whole schema as of 2026-10-26

Revision ID: 0001_baseline
Revises:
Create Date: 2026-10-26 21:05:44.876476

Replaces the 16 earlier migrations (initial schema through instrument_models),
which were joined into this one before any real database existed. A database
built by the old chain is identical to one built by this file; the one data row
the old chain inserted, the default "Flow cytometer" instrument type, is inserted
here too. From here on, add one migration per change as before.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0001_baseline'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('field_alias_groups',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('label', sa.String(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('instrument_models',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(), nullable=False),
    sa.Column('manufacturer', sa.String(), nullable=True),
    sa.Column('instrument_type', sa.String(), nullable=False),
    sa.Column('service_interval_months', sa.Integer(), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name')
    )
    op.create_table('instrument_types',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('key', sa.String(), nullable=False),
    sa.Column('display_name', sa.String(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('key')
    )
    op.create_table('report_templates',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('instrument_type', sa.String(), nullable=False),
    sa.Column('report_type', sa.Enum('repair', 'preventive_maintenance', 'installation_upgrade', name='report_type'), nullable=False),
    sa.Column('model', sa.String(), nullable=True),
    sa.Column('field_schema', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('uq_report_templates_type_model', 'report_templates', ['instrument_type', 'report_type', sa.literal_column("COALESCE(model, '')")], unique=True)
    op.create_table('saved_report_filters',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(), nullable=False),
    sa.Column('filters', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_by', sa.UUID(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('uq_saved_report_filters_name', 'saved_report_filters', [sa.literal_column('lower(btrim(name))')], unique=True)
    op.create_table('field_alias_names',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('group_id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(), nullable=False),
    sa.Column('normalized', sa.String(), nullable=False),
    sa.Column('position', sa.Integer(), server_default='0', nullable=False),
    sa.ForeignKeyConstraint(['group_id'], ['field_alias_groups.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('normalized')
    )
    op.create_index(op.f('ix_field_alias_names_group_id'), 'field_alias_names', ['group_id'], unique=False)
    op.create_table('instruments',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(), nullable=False),
    sa.Column('instrument_type', sa.String(), nullable=False),
    sa.Column('model', sa.String(), nullable=False),
    sa.Column('model_id', sa.UUID(), nullable=True),
    sa.Column('manufacturer', sa.String(), nullable=True),
    sa.Column('distributor', sa.String(), nullable=True),
    sa.Column('institution', sa.String(), nullable=True),
    sa.Column('serial_number', sa.String(), nullable=False),
    sa.Column('location', sa.String(), nullable=True),
    sa.Column('status', sa.Enum('active', 'maintenance', 'retired', name='instrument_status'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['model_id'], ['instrument_models.id'], name='fk_instruments_model_id'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('serial_number')
    )
    op.create_index(op.f('ix_instruments_model_id'), 'instruments', ['model_id'], unique=False)
    op.create_table('reports',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('instrument_id', sa.UUID(), nullable=True),
    sa.Column('template_id', sa.UUID(), nullable=True),
    sa.Column('status', sa.Enum('draft', 'classified', 'extracted', 'in_review', 'finalized', name='report_status'), nullable=False),
    sa.Column('extracted_fields', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('search_text', sa.Text(), nullable=True),
    sa.Column('technician_name', sa.String(), nullable=True),
    sa.Column('issuer', sa.String(), nullable=True),
    sa.Column('report_type_note', sa.String(), nullable=True),
    sa.Column('service_actions', sa.String(), nullable=True),
    sa.Column('parts_replaced', sa.String(), nullable=True),
    sa.Column('next_service_due', sa.Date(), nullable=True),
    sa.Column('report_date', sa.Date(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('finalized_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['instrument_id'], ['instruments.id'], ),
    sa.ForeignKeyConstraint(['template_id'], ['report_templates.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_reports_search_tsv', 'reports', [sa.literal_column("to_tsvector('simple', coalesce(search_text, ''))")], unique=False, postgresql_using='gin', postgresql_where=sa.text("status = 'finalized'"))
    op.create_table('attachments',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('report_id', sa.UUID(), nullable=False),
    sa.Column('file_path', sa.String(), nullable=False),
    sa.Column('file_type', sa.String(), nullable=False),
    sa.Column('page_count', sa.Integer(), nullable=False),
    sa.Column('content_sha256', sa.String(length=64), nullable=True),
    sa.Column('work_order_number', sa.String(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['report_id'], ['reports.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_attachments_content_sha256'), 'attachments', ['content_sha256'], unique=False)
    op.create_index(op.f('ix_attachments_work_order_number'), 'attachments', ['work_order_number'], unique=False)
    op.create_table('extraction_jobs',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('attachment_id', sa.UUID(), nullable=False),
    sa.Column('kind', sa.Enum('classify', 'extract', 'translate', name='extraction_job_kind'), nullable=False),
    sa.Column('status', sa.Enum('pending', 'classifying', 'extracting', 'translating', 'succeeded', 'failed', name='extraction_job_status'), nullable=False),
    sa.Column('classification', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('field_confidences', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('error_message', sa.String(), nullable=True),
    sa.Column('params', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['attachment_id'], ['attachments.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('translations',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('attachment_id', sa.UUID(), nullable=False),
    sa.Column('status', sa.Enum('pending_review', 'accepted', 'discarded', 'superseded', 'not_needed', name='translation_status'), nullable=False),
    sa.Column('source_language', sa.String(), nullable=False),
    sa.Column('hebrew_share', sa.Float(), nullable=True),
    sa.Column('model_text', sa.Text(), nullable=True),
    sa.Column('accepted_text', sa.Text(), nullable=True),
    sa.Column('ignored_pages', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'[]'::jsonb"), nullable=False),
    sa.Column('included_pages', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'[]'::jsonb"), nullable=False),
    sa.Column('identifier_check', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
    sa.Column('notes', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'[]'::jsonb"), nullable=False),
    sa.Column('reader', sa.String(), server_default='model', nullable=False),
    sa.Column('model', sa.String(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('accepted_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['attachment_id'], ['attachments.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_translations_attachment_id'), 'translations', ['attachment_id'], unique=False)
    # The default type every database starts with (instruments default to "facs").
    op.execute("INSERT INTO instrument_types (id, key, display_name) VALUES (gen_random_uuid(), 'facs', 'Flow cytometer')")


def downgrade() -> None:
    op.drop_index(op.f('ix_translations_attachment_id'), table_name='translations')
    op.drop_table('translations')
    op.drop_table('extraction_jobs')
    op.drop_index(op.f('ix_attachments_work_order_number'), table_name='attachments')
    op.drop_index(op.f('ix_attachments_content_sha256'), table_name='attachments')
    op.drop_table('attachments')
    op.drop_index('ix_reports_search_tsv', table_name='reports', postgresql_using='gin', postgresql_where=sa.text("status = 'finalized'"))
    op.drop_table('reports')
    op.drop_index(op.f('ix_instruments_model_id'), table_name='instruments')
    op.drop_table('instruments')
    op.drop_index(op.f('ix_field_alias_names_group_id'), table_name='field_alias_names')
    op.drop_table('field_alias_names')
    op.drop_index('uq_saved_report_filters_name', table_name='saved_report_filters')
    op.drop_table('saved_report_filters')
    op.drop_index('uq_report_templates_type_model', table_name='report_templates')
    op.drop_table('report_templates')
    op.drop_table('instrument_types')
    op.drop_table('instrument_models')
    op.drop_table('field_alias_groups')
    for enum_name in (
        'translation_status',
        'extraction_job_status',
        'extraction_job_kind',
        'report_status',
        'report_type',
        'instrument_status',
    ):
        op.execute(f'DROP TYPE IF EXISTS {enum_name}')
