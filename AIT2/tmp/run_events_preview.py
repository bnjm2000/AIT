import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import app as app_module
from data_manager import DataManager


preview_root = os.path.join(os.path.dirname(__file__), 'events-preview-data')
manager = DataManager(preview_root)
manager.setup_data_folder()
manager.check_and_initialize_files()
manager.load_all_data()

app_module.app.config['TESTING'] = True
app_module.set_data_manager_for_testing(manager)
app_module.app.run(
    host='127.0.0.1',
    port=5055,
    debug=False,
    use_reloader=False,
)
