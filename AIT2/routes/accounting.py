"""HTTP adapters for the accounting workspace. Dependencies stay company scoped."""
import copy
import csv
import hashlib
import io
from pathlib import Path

from flask import Response, jsonify, request, send_file
from werkzeug.utils import secure_filename

from services import accounting_workspace as books
from services.accounting_reports import build_report
from services.accounting_close import dashboard, filing_report, filing_view
from services.accounting_exports import pack_xlsx, report_xlsx
from services.accounting_documents import document_view, document_html, document_pdf


def register_accounting_routes(app, *, auth, lock, load, save, store_for, payload,
                               actor, role, users, finance_path, changed,
                               pdf_company=None):
    prefix = '/api/finance/accounting'

    def mutate(callback):
        try:
            with lock:
                data = load()
                # No partially applied batch can escape if a later item fails validation.
                store = books.initialise(copy.deepcopy(store_for(data)))
                current_role = role()
                record = callback(store, current_role)
                data['accounting'] = store
                save(data)
                response = payload(data, request.args)
            changed('finance', {'action': 'accounting-workspace-updated'})
            return jsonify(success=True, data=response, record=record)
        except PermissionError as exc:
            return jsonify(error=str(exc)), 403
        except (ValueError, TypeError, KeyError) as exc:
            return jsonify(error=str(exc) if isinstance(exc, ValueError) else 'Invalid accounting request'), 400

    @app.route(prefix + '/documents', methods=['POST'])
    @auth
    def accounting_document_create():
        value = request.get_json(silent=True) or {}
        return mutate(lambda store, role: books.save_document(store, value, actor()))

    @app.route(prefix + '/documents/<record_id>', methods=['PUT'])
    @auth
    def accounting_document_update(record_id):
        value = request.get_json(silent=True) or {}
        return mutate(lambda store, role: books.save_document(store, value, actor(), record_id))

    @app.route(prefix + '/documents/<record_id>/preview', methods=['GET'])
    @app.route(prefix + '/documents/<record_id>/pdf', methods=['GET'])
    @auth
    def accounting_document_export(record_id):
        try:
            with lock:
                store = books.initialise(store_for(load()))
                view = copy.deepcopy(document_view(store, books.find(store, 'documents', record_id)))
            if request.path.endswith('/pdf'):
                filename = secure_filename(view['document']['number']) or 'accounting-document'
                company = pdf_company() if callable(pdf_company) else {}
                response = send_file(document_pdf(view, company=company), as_attachment=True,
                                     download_name=filename + '.pdf', mimetype='application/pdf')
            else:
                response = jsonify(success=True, html=document_html(view), warnings=view['warnings'])
            response.headers['Cache-Control'] = 'private, no-store'
            response.headers['X-Content-Type-Options'] = 'nosniff'
            return response
        except ValueError as exc:
            return jsonify(error=str(exc)), 400

    @app.route(prefix + '/documents/<record_id>/<action>', methods=['POST'])
    @auth
    def accounting_document_action(record_id, action):
        return mutate(lambda store, role: books.document_action(store, record_id, action, actor(), role))

    @app.route(prefix + '/actions/<action>', methods=['POST'])
    @auth
    def accounting_action(action):
        value = request.get_json(silent=True) or {}
        return mutate(lambda store, role: books.command(store, action, value, actor(), role, users()))

    @app.route(prefix + '/reports/<report_name>', methods=['GET'])
    @auth
    def accounting_report(report_name):
        try:
            with lock:
                table = build_report(store_for(load()), report_name, request.args)
            if request.args.get('format') == 'xlsx':
                return send_file(report_xlsx(table), as_attachment=True,
                                 download_name=f'accounting-{report_name}.xlsx',
                                 mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
            if request.args.get('format') == 'csv':
                output = io.StringIO()
                writer = csv.writer(output)
                def safe(value):
                    # Spreadsheet programs must not interpret contact / memo text as formulas.
                    if isinstance(value, str) and value.lstrip().startswith(('=', '+', '-', '@', '\t', '\r')):
                        return "'" + value
                    return value
                writer.writerow([table['title'], table['period']['from'], table['period']['to'], table['currency']])
                writer.writerow([c['label'] for c in table['columns']])
                for row in table['rows']:
                    writer.writerow([safe(row.get(c['key'], '')) for c in table['columns']])
                writer.writerow([])
                for note in table['notes']:
                    writer.writerow([safe(note)])
                return Response('\ufeff' + output.getvalue(), mimetype='text/csv',
                                headers={'Content-Disposition': f'attachment; filename="accounting-{report_name}.csv"'})
            return jsonify(success=True, report=table)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400

    @app.route(prefix + '/close', methods=['GET'])
    @auth
    def accounting_close_dashboard():
        try:
            with lock:
                data = dashboard(books.initialise(store_for(load())), request.args)
            return jsonify(success=True, close=data)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400

    @app.route(prefix + '/packs/<record_id>/<export_format>', methods=['GET'])
    @auth
    def accounting_pack_download(record_id, export_format):
        try:
            with lock:
                pack = copy.deepcopy(books.find(books.initialise(store_for(load())), 'reportPacks', record_id))
            if export_format == 'xlsx':
                return send_file(pack_xlsx(pack), as_attachment=True,
                                 download_name=f'accounting-pack-{pack["period"]["to"]}.xlsx',
                                 mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
            if export_format == 'json':
                response = jsonify(pack)
                response.headers['Content-Disposition'] = f'attachment; filename="accounting-pack-{record_id}.json"'
                return response
            raise ValueError('Choose Excel or the retained data snapshot')
        except ValueError as exc:
            return jsonify(error=str(exc)), 400

    @app.route(prefix + '/filings/<record_id>', methods=['GET'])
    @auth
    def accounting_filing_detail(record_id):
        try:
            with lock:
                store = books.initialise(store_for(load()))
                filing = filing_view(store, books.find(store, 'filings', record_id))
            return jsonify(success=True, filing=filing)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400

    @app.route(prefix + '/filings/<record_id>/xlsx', methods=['GET'])
    @auth
    def accounting_filing_export(record_id):
        try:
            with lock:
                store = books.initialise(store_for(load()))
                table = filing_report(books.find(store, 'filings', record_id))
            return send_file(report_xlsx(table), as_attachment=True,
                             download_name=f'filing-working-paper-{record_id}.xlsx',
                             mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        except ValueError as exc:
            return jsonify(error=str(exc)), 400

    @app.route(prefix + '/audit', methods=['GET'])
    @auth
    def accounting_audit_export():
        with lock:
            store = store_for(load())
            return jsonify(success=True, entries=store['auditTrail'])

    @app.route(prefix + '/attachments/<collection>/<record_id>', methods=['POST'])
    @auth
    def accounting_attachment_upload(collection, record_id):
        uploaded = request.files.get('file')
        if collection not in {'documents', 'journals', 'fixedAssets', 'filings', 'bankReconciliations'} or not uploaded:
            return jsonify(error='Choose a source document and a valid transaction'), 400
        name = secure_filename(uploaded.filename or '')
        extensions = {'.pdf', '.png', '.jpg', '.jpeg', '.webp', '.csv', '.xlsx', '.docx', '.txt'}
        if collection == 'filings':
            extensions.update({'.xml', '.xbrl', '.zip'})
        if Path(name).suffix.lower() not in extensions:
            return jsonify(error='Use PDF, image, CSV, Excel, Word or text; filing packages also accept XML, XBRL and ZIP'), 400
        content = uploaded.read(10 * 1024 * 1024 + 1)
        if not content or len(content) > 10 * 1024 * 1024:
            return jsonify(error='Attachments must be between 1 byte and 10 MB'), 400
        saved_path = None
        def attach(store, role):
            nonlocal saved_path
            books.allow(role, 'write')
            books.find(store, collection, record_id)
            attachment_id = books.uid()
            folder = Path(finance_path()).parent / 'accounting_documents'
            folder.mkdir(parents=True, exist_ok=True)
            saved_path = folder / attachment_id
            saved_path.write_bytes(content)
            record = dict(id=attachment_id, collection=collection, recordId=record_id,
                          name=name, size=len(content), sha256=hashlib.sha256(content).hexdigest(),
                          uploadedAt=books.now(), uploadedBy=actor())
            store['attachments'].append(record)
            books.audit(store, actor(), 'attachment.added', record_id, after=record)
            return record
        response = mutate(attach)
        status = response[1] if isinstance(response, tuple) else response.status_code
        if status >= 400 and saved_path and saved_path.exists():
            saved_path.unlink()
        return response

    @app.route(prefix + '/attachments/<attachment_id>', methods=['GET'])
    @auth
    def accounting_attachment_download(attachment_id):
        with lock:
            store = store_for(load())
            try:
                record = books.find(store, 'attachments', attachment_id)
            except ValueError:
                return jsonify(error='Attachment not found'), 404
            path = Path(finance_path()).parent / 'accounting_documents' / record['id']
            if not path.is_file():
                return jsonify(error='Source file is unavailable'), 404
            response = send_file(path, as_attachment=True, download_name=record['name'], mimetype='application/octet-stream')
            response.headers['X-Content-Type-Options'] = 'nosniff'
            response.headers['Cache-Control'] = 'private, no-store'
            return response
