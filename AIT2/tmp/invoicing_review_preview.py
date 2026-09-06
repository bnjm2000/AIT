"""Local, disposable sample invoices for browser workflow review."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.test_invoicing_workflow import InvoicingWorkflowTests
import app as app_module

fixture = InvoicingWorkflowTests()
fixture.setUp()
quotation, _ = fixture.create_plan(500)
fixture.issue(quotation)
app_module.app.config.update(TESTING=True, SESSION_COOKIE_SECURE=False)
print('Invoicing review: http://127.0.0.1:5058/invoices; sample login alice / pw', flush=True)
try:
    app_module.app.run(host='127.0.0.1', port=5058, use_reloader=False, debug=False)
finally:
    fixture.tearDown()
